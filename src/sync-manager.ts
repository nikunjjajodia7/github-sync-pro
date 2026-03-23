import {
  Vault,
  Notice,
  normalizePath,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from "obsidian";
import GithubClient, {
  GetTreeResponseItem,
  NewTreeRequestItem,
  RepoContent,
} from "./github/client";
import MetadataStore, {
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GitHubSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import { decodeBase64String, hasTextExtension } from "./utils";
import GitHubSyncPlugin from "./main";
import { BlobReader, Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { isTrackableSyncPath } from "./sync-scope";
import { tryThreeWayMerge } from "./auto-merge";

interface SyncAction {
  type: "upload" | "download" | "delete_local" | "delete_remote";
  filePath: string;
}

interface ActionExecutionResult {
  filePath: string;
  type: SyncAction["type"];
  ok: boolean;
  error?: string;
}

interface SyncRunSummary {
  succeeded: ActionExecutionResult[];
  failed: ActionExecutionResult[];
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  strategy?: "local" | "remote";
  content?: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

class BranchHeadAdvancedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchHeadAdvancedError";
  }
}

export default class SyncManager {
  private metadataStore: MetadataStore;
  private client: GithubClient;
  private eventsListener: EventsListener;
  private syncIntervalId: number | null = null;
  private pushOnSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly PUSH_ON_SAVE_DEBOUNCE_MS = 2000;

  // Use to track if syncing is in progress, this ideally
  // prevents multiple syncs at the same time and creation
  // of messy conflicts.
  private syncing: boolean = false;

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
  ) {
    this.metadataStore = new MetadataStore(this.vault);
    this.client = new GithubClient(this.settings, this.logger);
    this.eventsListener = new EventsListener(
      this.vault,
      this.metadataStore,
      this.settings,
      this.logger,
    );

    // Wire up push-on-save: when EventsListener detects dirty files,
    // schedule a sync after a 2s debounce (only in interval mode).
    this.eventsListener.onDirtyFiles = () => {
      if (this.settings.syncStrategy !== "interval") return;
      if (this.pushOnSaveTimer !== null) {
        clearTimeout(this.pushOnSaveTimer);
      }
      this.pushOnSaveTimer = setTimeout(() => {
        this.pushOnSaveTimer = null;
        // If a sync is already running, re-arm the timer to try again
        if (this.syncing) {
          this.pushOnSaveTimer = setTimeout(
            () => this.eventsListener.onDirtyFiles?.(),
            SyncManager.PUSH_ON_SAVE_DEBOUNCE_MS,
          );
          return;
        }
        this.sync().catch(() => {
          // Errors are already handled inside sync() via Notice.
          // Catch here to prevent unhandled promise rejection from setTimeout.
        });
      }, SyncManager.PUSH_ON_SAVE_DEBOUNCE_MS);
    };
  }

  /**
   * Returns the current GitHub API rate limit info.
   */
  getRateLimit() {
    return this.client.rateLimit;
  }

  /**
   * Returns the GitHub API client (for version history and other read operations).
   */
  getClient() {
    return this.client;
  }

  /**
   * Returns true if a sync is currently in progress.
   */
  isSyncing() {
    return this.syncing;
  }

  /**
   * Mark a file as dirty so the next sync uploads it.
   * Used after version history restore to prevent the remote from overwriting.
   */
  markFileDirty(filePath: string) {
    const meta = this.metadataStore.data.files[filePath];
    if (meta) {
      meta.dirty = true;
      meta.sha = null; // force re-upload
      meta.lastModified = Date.now();
    }
    this.metadataStore.save();
  }

  private isTrackablePath(filePath: string, includeManifest: boolean = false): boolean {
    return isTrackableSyncPath(filePath, {
      configDir: this.vault.configDir,
      manifestPath: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
      logPath: `${this.vault.configDir}/${LOG_FILE_NAME}`,
      syncConfigDir: this.settings.syncConfigDir,
      syncScopeMode: this.settings.syncScopeMode,
      excludePatterns: this.settings.excludePatterns || [],
      includeManifest,
    });
  }

  private shouldSkipSyncPath(filePath: string): boolean {
    return !this.isTrackablePath(filePath, false);
  }

  /**
   * Returns true if the local vault root is empty.
   */
  private async vaultIsEmpty(): Promise<boolean> {
    const { files, folders } = await this.vault.adapter.list(
      this.vault.getRoot().path,
    );
    // There are files or folders in the vault dir
    return (
      files.length === 0 &&
      // We filter out the config dir since is always present so it's fine if we find it.
      folders.filter((f) => f !== this.vault.configDir).length === 0
    );
  }

  /**
   * Handles first sync with remote and local.
   * This fails if neither remote nor local folders are empty.
   */
  async firstSync() {
    if (this.syncing) {
      this.logger.info("First sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    this.syncing = true;
    try {
      await this.firstSyncImpl();
    } finally {
      this.syncing = false;
    }
  }

  private async firstSyncImpl() {
    await this.logger.info("Starting first sync");
    let repositoryIsEmpty = false;
    let res: RepoContent;
    let files: {
      [key: string]: GetTreeResponseItem;
    } = {};
    let treeSha: string = "";
    try {
      res = await this.client.getRepoContent();
      files = res.files;
      treeSha = res.sha;
    } catch (err) {
      // 409 is returned in case the remote repo has been just created
      // and contains no files.
      // 404 instead is returned in case there are no files.
      // Either way we can handle both by commiting a new empty manifest.
      if (err.status !== 409 && err.status !== 404) {
        throw err;
      }
      // The repository is bare, meaning it has no tree, no commits and no branches
      repositoryIsEmpty = true;
    }

    if (repositoryIsEmpty) {
      await this.logger.info("Remote repository is empty");
      // Since the repository is completely empty we need to create a first commit.
      // We can't create that by going throught the normal sync process since the
      // API doesn't let us create a new tree when the repo is empty.
      // So we create a the manifest file as the first commit, since we're going
      // to create that in any case right after this.
      const buffer = await this.vault.adapter.readBinary(
        normalizePath(`${this.vault.configDir}/${MANIFEST_FILE_NAME}`),
      );
      await this.client.createFile({
        path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
        content: arrayBufferToBase64(buffer),
        message: "First sync",
        retry: true,
      });
      // Now get the repo content again cause we know for sure it will return a
      // valid sha that we can use to create the first sync commit.
      res = await this.client.getRepoContent({ retry: true });
      files = res.files;
      treeSha = res.sha;
    }

    const vaultIsEmpty = await this.vaultIsEmpty();

    if (!repositoryIsEmpty && !vaultIsEmpty) {
      // Both sides already contain files, so we skip first-sync bootstrap
      // and continue with regular incremental sync.
      await this.logger.info(
        "Both remote and local have files, falling through to incremental sync",
      );
      await this.syncImpl();
      return;
    } else if (repositoryIsEmpty) {
      // Remote has no files and no manifest, let's just upload whatever we have locally.
      // This is fine even if the vault is empty.
      // The most important thing at this point is that the remote manifest is created.
      await this.firstSyncFromLocal(files, treeSha);
    } else {
      // Local has no files and there's no manifest in the remote repo.
      // Let's download whatever we have in the remote repo.
      // This is fine even if the remote repo is empty.
      // In this case too the important step is that the remote manifest is created.
      await this.firstSyncFromRemote(files, treeSha);
    }
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the local content dir while
   * remote has files in the repo content dir but no manifest file.
   *
   * @param files All files in the remote repository, including those not in its content dir.
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromRemote(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    await this.logger.info("Starting first sync from remote files");

    // We want to avoid getting throttled by GitHub, so instead of making a request for each
    // file we download the whole repository as a ZIP file and extract it in the vault.
    // We exclude config dir files if the user doesn't want to sync those.
    const zipBuffer = await this.client.downloadRepositoryArchive();
    const zipBlob = new Blob([zipBuffer]);
    const reader = new ZipReader(new BlobReader(zipBlob));
    const entries = await reader.getEntries();

    await this.logger.info("Extracting files from ZIP", {
      length: entries.length,
    });

    await Promise.all(
      entries.map(async (entry: Entry) => {
        // All repo ZIPs contain a root directory that contains all the content
        // of that repo, we need to ignore that directory so we strip the first
        // folder segment from the path
        const pathParts = entry.filename.split("/");
        const targetPath =
          pathParts.length > 1 ? pathParts.slice(1).join("/") : entry.filename;

        if (targetPath === "") {
          // Must be the root folder, skip it.
          // This is really important as that would lead us to try and
          // create the folder "/" and crash Obsidian
          return;
        }

        if (entry.directory) {
          const normalizedPath = normalizePath(targetPath);
          await this.vault.adapter.mkdir(normalizedPath);
          await this.logger.info("Created directory", {
            normalizedPath,
          });
          return;
        }

        if (this.shouldSkipSyncPath(targetPath)) {
          await this.logger.info("Skipped non-trackable path", { targetPath });
          return;
        }

        if (targetPath === `${this.vault.configDir}/${LOG_FILE_NAME}`) {
          // We don't want to download the log file if the user synced it in the past.
          // This is necessary because in the past we forgot to ignore the log file
          // from syncing if the user enabled configs sync.
          // To avoid downloading it we ignore it if still present in the remote repo.
          return;
        }

        if (targetPath.split("/").last()?.startsWith(".")) {
          // We must skip hidden files as that creates issues with syncing.
          // This is fine as users can't edit hidden files in Obsidian anyway.
          await this.logger.info("Skipping hidden file", targetPath);
          return;
        }

        const writer = new Uint8ArrayWriter();
        await entry.getData!(writer);
        const data = await writer.getData();
        const dir = targetPath.split("/").splice(0, -1).join("/");
        if (dir !== "") {
          const normalizedDir = normalizePath(dir);
          await this.vault.adapter.mkdir(normalizedDir);
          await this.logger.info("Created directory", {
            normalizedDir,
          });
        }

        const normalizedPath = normalizePath(targetPath);
        const buffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        );
        await this.vault.adapter.writeBinary(normalizedPath, buffer);
        await this.logger.info("Written file", {
          normalizedPath,
        });
        this.metadataStore.data.files[normalizedPath] = {
          path: normalizedPath,
          sha: files[normalizedPath].sha,
          dirty: false,
          justDownloaded: true,
          lastModified: Date.now(),
          ancestorSha: files[normalizedPath].sha,
        };
      }),
    );

    // Save metadata once after all files are extracted, not per-file.
    // For a 1000-file vault this avoids 1000 sequential disk writes.
    await this.metadataStore.save();

    await this.logger.info("Extracted zip");

    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
    // Add files that are in the manifest but not in the tree.
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          return (
            this.isTrackablePath(filePath, true) &&
            !Object.keys(files).contains(filePath)
          );
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            content = await this.vault.adapter.read(normalizedPath);
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    await this.commitSync(newTreeFiles, treeSha);
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the remote repo and no manifest while
   * local vault has files and a manifest.
   *
   * @param files All files in the remote repository
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromLocal(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    await this.logger.info("Starting first sync from local files");
    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          // We should not try to sync deleted files, this can happen when
          // the user renames or deletes files after enabling the plugin but
          // before syncing for the first time
          return (
            this.isTrackablePath(filePath, true) &&
            !this.metadataStore.data.files[filePath].deleted
          );
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            content = await this.vault.adapter.read(normalizedPath);
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    await this.commitSync(newTreeFiles, treeSha);
  }

  /**
   * Syncs local and remote folders.
   * @returns
   */
  async sync() {
    if (this.syncing) {
      this.logger.info("Sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    const notice = new Notice("Syncing...");
    this.syncing = true;
    try {
      const maxAttempts = 2;
      let attempt = 1;
      let summary: SyncRunSummary = { succeeded: [], failed: [] };
      while (attempt <= maxAttempts) {
        try {
          summary = await this.syncImpl();
          break;
        } catch (err) {
          const isRetryableRace = err instanceof BranchHeadAdvancedError;
          if (!isRetryableRace || attempt >= maxAttempts) {
            throw err;
          }
          await this.logger.warn(
            "Sync replaying after remote branch advanced",
            { attempt, maxAttempts },
          );
          attempt++;
        }
      }
      if (summary.failed.length > 0) {
        await this.logger.warn("Sync partial", {
          successCount: summary.succeeded.length,
          failureCount: summary.failed.length,
          failed: summary.failed,
        });
        new Notice(
          `Sync partial: ${summary.succeeded.length} succeeded, ${summary.failed.length} failed (will retry)`,
          7000,
        );
      } else {
        // Shown only if sync doesn't fail
        new Notice("Sync successful", 5000);
      }
    } catch (err) {
      // Show the error to the user, it's not automatically dismissed to make sure
      // the user sees it.
      new Notice(`Error syncing. ${err}`);
    } finally {
      this.syncing = false;
      notice.hide();
    }
  }

  private async syncImpl(): Promise<SyncRunSummary> {
    const summary: SyncRunSummary = { succeeded: [], failed: [] };
    await this.logger.info("Starting sync");
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    const manifest = files[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`];

    if (manifest === undefined) {
      await this.logger.error("Remote manifest is missing", { files, treeSha });
      throw new Error("Remote manifest is missing");
    }

    if (
      Object.keys(files).contains(`${this.vault.configDir}/${LOG_FILE_NAME}`)
    ) {
      // We don't want to download the log file if the user synced it in the past.
      // This is necessary because in the past we forgot to ignore the log file
      // from syncing if the user enabled configs sync.
      // To avoid downloading it we delete it if still around.
      delete files[`${this.vault.configDir}/${LOG_FILE_NAME}`];
    }

    const blob = await this.client.getBlob({ sha: manifest.sha });
    const remoteMetadata: Metadata = JSON.parse(
      decodeBase64String(blob.content),
    );
    let metadataChanged = false;
    if (!remoteMetadata.files) {
      remoteMetadata.files = {};
    }

    const removedEntries = await this.cleanupUntrackableMetadataEntries();
    if (removedEntries > 0) {
      metadataChanged = true;
    }

    // Reconcile remote metadata with the actual remote tree state to support
    // changes made outside of this plugin (PRs/direct commits/other tools).
    Object.keys(files).forEach((filePath: string) => {
      if (this.shouldSkipSyncPath(filePath)) {
        return;
      }
      const treeFile = files[filePath];
      const metadataFile = remoteMetadata.files[filePath];
      if (metadataFile) {
        if (metadataFile.sha !== treeFile.sha) {
          metadataFile.lastModified = Date.now();
        }
        metadataFile.sha = treeFile.sha;
        if (metadataFile.deleted) {
          metadataFile.deleted = false;
          delete metadataFile.deletedAt;
        }
      } else {
        remoteMetadata.files[filePath] = {
          path: filePath,
          sha: treeFile.sha,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
      }
    });

    Object.keys(remoteMetadata.files).forEach((filePath: string) => {
      if (this.shouldSkipSyncPath(filePath)) {
        return;
      }
      if (!files[filePath] && !remoteMetadata.files[filePath].deleted) {
        remoteMetadata.files[filePath].deleted = true;
        remoteMetadata.files[filePath].deletedAt = Date.now();
      }
    });

    const hydratedEntries = await this.hydrateMissingBaselines(
      files,
      remoteMetadata.files,
    );
    if (hydratedEntries > 0) {
      metadataChanged = true;
    }

    const conflicts = await this.findConflicts(remoteMetadata.files);

    // We treat every resolved conflict as an upload SyncAction, mainly cause
    // the user has complete freedom on the edits they can apply to the conflicting files.
    // So when a conflict is resolved we change the file locally and upload it.
    // That solves the conflict.
    let conflictActions: SyncAction[] = [];
    // We keep track of the conflict resolutions cause we want to update the file
    // locally only when we're sure the sync was successul. That happens after we
    // commit the sync.
    let conflictResolutions: ConflictResolution[] = [];

    // Attempt auto-merge for text conflicts that have a known ancestor
    const remainingConflicts: ConflictFile[] = [];
    for (const conflict of conflicts) {
      if (!conflict.localContent || !conflict.remoteContent) {
        // Binary or empty content — can't auto-merge
        remainingConflicts.push(conflict);
        continue;
      }
      const localMeta = this.metadataStore.data.files[conflict.filePath];
      if (!localMeta?.ancestorSha) {
        // No ancestor available — fall back to manual resolution
        remainingConflicts.push(conflict);
        continue;
      }
      try {
        const ancestorBlob = await this.client.getBlob({
          sha: localMeta.ancestorSha,
          retry: true,
          maxRetries: 1,
        });
        const ancestorContent = decodeBase64String(ancestorBlob.content);
        const mergeResult = tryThreeWayMerge(
          conflict.localContent,
          conflict.remoteContent,
          ancestorContent,
        );
        if (mergeResult.clean && mergeResult.mergedContent !== null) {
          // Clean merge! Apply locally and mark as upload
          await this.vault.adapter.write(
            normalizePath(conflict.filePath),
            mergeResult.mergedContent,
          );
          conflictResolutions.push({
            filePath: conflict.filePath,
            strategy: "local",
            content: mergeResult.mergedContent,
          });
          conflictActions.push({
            type: "upload",
            filePath: conflict.filePath,
          });
          await this.logger.info("Auto-merged conflict", conflict.filePath);
          continue;
        }
      } catch (err) {
        // Ancestor fetch failed — fall through to manual resolution
        await this.logger.warn("Auto-merge ancestor fetch failed, falling back to manual", {
          filePath: conflict.filePath,
          error: String(err),
        });
      }
      remainingConflicts.push(conflict);
    }

    if (remainingConflicts.length > 0) {
      await this.logger.warn("Found conflicts", remainingConflicts);
      if (this.settings.conflictHandling === "ask") {
        // Here we block the sync process until the user has resolved all conflicts.
        // Conflict choices map directly to sync actions:
        // - local => upload local version
        // - remote => download remote version
        conflictResolutions = await this.onConflicts(remainingConflicts);
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => ({
            type: resolution.strategy === "remote" ? "download" : "upload",
            filePath: resolution.filePath,
          }),
        );
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        conflictActions.push(...remainingConflicts.map((conflict: ConflictFile) => ({
          type: "download" as const, filePath: conflict.filePath,
        })));
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        conflictActions.push(...remainingConflicts.map((conflict: ConflictFile) => ({
          type: "upload" as const, filePath: conflict.filePath,
        })));
      }
    }

    const actions: SyncAction[] = [
      ...(await this.determineSyncActions(
        remoteMetadata.files,
        this.metadataStore.data.files,
        conflictActions.map((action) => action.filePath),
      )),
      ...conflictActions,
    ];

    // Add remote files not present in either metadata store.
    Object.keys(files).forEach((filePath: string) => {
      if (this.shouldSkipSyncPath(filePath)) {
        return;
      }
      if (
        !remoteMetadata.files[filePath] &&
        !this.metadataStore.data.files[filePath] &&
        !actions.find((action) => action.filePath === filePath)
      ) {
        actions.push({ type: "download", filePath });
      }
    });

    const newTreeFiles: { [key: string]: NewTreeRequestItem } = Object.keys(
      files,
    )
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );

    if (actions.length === 0) {
      if (metadataChanged) {
        await this.logger.info(
          "No file actions to sync, committing metadata updates only",
        );
        await this.commitSync(newTreeFiles, treeSha);
        return summary;
      }
      // Nothing to sync
      await this.logger.info("Nothing to sync");
      return summary;
    }
    await this.logger.info("Actions to sync", actions);

    const preparedRemoteActions: SyncAction[] = [];
    const preparedConflictResolutions: ConflictResolution[] = [];

    for (const action of actions) {
      if (action.type !== "upload" && action.type !== "delete_remote") {
        continue;
      }
      try {
        switch (action.type) {
          case "upload": {
            const normalizedPath = normalizePath(action.filePath);
            // Ghost file detection: if the file no longer exists locally,
            // mark it as deleted in metadata and skip the upload.
            if (!(await this.vault.adapter.exists(normalizedPath))) {
              await this.logger.warn("Ghost file detected — marking as deleted", action.filePath);
              if (this.metadataStore.data.files[action.filePath]) {
                this.metadataStore.data.files[action.filePath].deleted = true;
                this.metadataStore.data.files[action.filePath].deletedAt = Date.now();
              }
              continue;
            }
            const resolution = conflictResolutions.find(
              (c: ConflictResolution) => c.filePath === action.filePath,
            );
            // If the file was conflicting we need to read the content from the
            // conflict resolution instead of reading it from file since at this point
            // we still have not updated the local file.
            let content = resolution?.content;
            if (!content) {
              // Keep binary files out of text read path. commitSync() will upload
              // the binary blob from readBinary() based on extension checks.
              content = hasTextExtension(normalizedPath)
                ? await this.vault.adapter.read(normalizedPath)
                : "binaryfile";
            }
            newTreeFiles[action.filePath] = {
              path: action.filePath,
              mode: "100644",
              type: "blob",
              content: content,
            };
            preparedRemoteActions.push(action);
            if (resolution) {
              preparedConflictResolutions.push(resolution);
            }
            break;
          }
          case "delete_remote": {
            if (!newTreeFiles[action.filePath]) {
              throw new Error("Missing remote tree item for delete_remote");
            }
            newTreeFiles[action.filePath].sha = null;
            preparedRemoteActions.push(action);
            break;
          }
        }
      } catch (err) {
        summary.failed.push({
          filePath: action.filePath,
          type: action.type,
          ok: false,
          error: `${err}`,
        });
        await this.logger.warn("Action failed", {
          filePath: action.filePath,
          type: action.type,
          error: `${err}`,
        });
        if (!this.metadataStore.data.files[action.filePath]) {
          this.metadataStore.data.files[action.filePath] = {
            path: action.filePath,
            sha: null,
            dirty: true,
            justDownloaded: false,
            lastModified: Date.now(),
          };
        } else {
          this.metadataStore.data.files[action.filePath].dirty = true;
          this.metadataStore.data.files[action.filePath].lastModified =
            Date.now();
        }
      }
    }

    // Download files and delete local files
    for (const action of actions.filter((item) => item.type === "download")) {
      try {
        await this.downloadFile(
          files[action.filePath],
          remoteMetadata.files[action.filePath]
            ? remoteMetadata.files[action.filePath].lastModified
            : Date.now(),
        );
        summary.succeeded.push({
          filePath: action.filePath,
          type: action.type,
          ok: true,
        });
      } catch (err) {
        summary.failed.push({
          filePath: action.filePath,
          type: action.type,
          ok: false,
          error: `${err}`,
        });
        await this.logger.warn("Action failed", {
          filePath: action.filePath,
          type: action.type,
          error: `${err}`,
        });
      }
    }

    for (const action of actions.filter((item) => item.type === "delete_local")) {
      try {
        await this.deleteLocalFile(action.filePath);
        summary.succeeded.push({
          filePath: action.filePath,
          type: action.type,
          ok: true,
        });
      } catch (err) {
        summary.failed.push({
          filePath: action.filePath,
          type: action.type,
          ok: false,
          error: `${err}`,
        });
        await this.logger.warn("Action failed", {
          filePath: action.filePath,
          type: action.type,
          error: `${err}`,
        });
      }
    }

    if (preparedRemoteActions.length > 0) {
      try {
        await this.commitSync(
          newTreeFiles,
          treeSha,
          preparedConflictResolutions,
        );
        summary.succeeded.push(
          ...preparedRemoteActions.map((action) => ({
            filePath: action.filePath,
            type: action.type,
            ok: true,
          })),
        );
      } catch (err) {
        if (err instanceof BranchHeadAdvancedError) {
          throw err;
        }
        summary.failed.push(
          ...preparedRemoteActions.map((action) => ({
            filePath: action.filePath,
            type: action.type,
            ok: false,
            error: `${err}`,
          })),
        );
        await this.logger.error("Remote commit failed for prepared actions", {
          error: `${err}`,
          preparedRemoteActions,
        });
      }
    } else if (metadataChanged) {
      await this.commitSync(newTreeFiles, treeSha);
    }

    return summary;
  }

  /**
   * Backfills missing baseline SHAs for files where local and remote content
   * are already identical. This prevents false conflict detection.
   */
  private async hydrateMissingBaselines(
    remoteTreeFiles: { [key: string]: GetTreeResponseItem },
    remoteMetadataFiles: { [key: string]: FileMetadata },
  ): Promise<number> {
    let hydratedCount = 0;
    const commonFiles = Object.keys(remoteTreeFiles).filter((filePath) => {
      if (this.shouldSkipSyncPath(filePath)) {
        return false;
      }
      return filePath in this.metadataStore.data.files;
    });

    await Promise.all(
      commonFiles.map(async (filePath: string) => {
        const localFile = this.metadataStore.data.files[filePath];
        const remoteMetadataFile = remoteMetadataFiles[filePath];
        const remoteTreeFile = remoteTreeFiles[filePath];
        if (!localFile || !remoteTreeFile || !remoteMetadataFile) {
          return;
        }
        if (localFile.deleted || remoteMetadataFile.deleted) {
          return;
        }
        if (localFile.sha !== null) {
          return;
        }

        const localSHA = await this.calculateSHA(filePath);
        if (localSHA !== null && localSHA === remoteTreeFile.sha) {
          localFile.sha = remoteTreeFile.sha;
          localFile.dirty = false;
          hydratedCount++;
        }
      }),
    );

    if (hydratedCount > 0) {
      await this.metadataStore.save();
      await this.logger.info("Hydrated missing file baselines", {
        count: hydratedCount,
      });
    }
    return hydratedCount;
  }

  private async cleanupUntrackableMetadataEntries(): Promise<number> {
    let removedCount = 0;
    Object.keys(this.metadataStore.data.files).forEach((filePath) => {
      if (!this.isTrackablePath(filePath, true)) {
        delete this.metadataStore.data.files[filePath];
        removedCount++;
      }
    });
    if (removedCount > 0) {
      await this.metadataStore.save();
      await this.logger.info("Removed untrackable metadata entries", {
        count: removedCount,
      });
    }
    return removedCount;
  }

  /**
   * Finds conflicts between local and remote files.
   * @param filesMetadata Remote files metadata
   * @returns List of object containing file path, remote and local content of conflicting files
   */
  async findConflicts(filesMetadata: {
    [key: string]: FileMetadata;
  }): Promise<ConflictFile[]> {
    const commonFiles = Object.keys(filesMetadata).filter(
      (key) => key in this.metadataStore.data.files,
    );
    if (commonFiles.length === 0) {
      return [];
    }

    const conflicts = await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file is only internal, the user must not
          // handle conflicts for this
          return null;
        }
        const remoteFile = filesMetadata[filePath];
        const localFile = this.metadataStore.data.files[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          return null;
        }
        if (localFile.sha === null || remoteFile.sha === null) {
          // Missing baseline means we cannot perform trusted 3-way conflict detection.
          return null;
        }
        const actualLocalSHA = await this.calculateSHA(filePath);
        if (actualLocalSHA === null) {
          return null;
        }
        const remoteFileHasBeenModifiedSinceLastSync =
          remoteFile.sha !== localFile.sha;
        const localFileHasBeenModifiedSinceLastSync =
          actualLocalSHA !== localFile.sha;
        // This is an unlikely case. If the user manually edits
        // the local file so that's identical to the remote one,
        // but the local metadata SHA is different we don't want
        // to show a conflict.
        // Since that would show two identical files.
        // Checking for this prevents showing a non conflict to the user.
        const actualFilesAreDifferent = remoteFile.sha !== actualLocalSHA;
        if (
          remoteFileHasBeenModifiedSinceLastSync &&
          localFileHasBeenModifiedSinceLastSync &&
          actualFilesAreDifferent
        ) {
          return filePath;
        }
        return null;
      }),
    );

    const conflictPaths = conflicts.filter(
      (filePath): filePath is string => filePath !== null,
    );
    return await Promise.all(
      conflictPaths.map(async (filePath: string) => {
        if (!hasTextExtension(filePath)) {
          // Binary conflicts are resolved by conflict strategy actions and
          // don't need text payloads.
          return {
            filePath,
            remoteContent: "",
            localContent: "",
          };
        }
        // Load contents in parallel
        const [remoteContent, localContent] = await Promise.all([
          await (async () => {
            const res = await this.client.getBlob({
              sha: filesMetadata[filePath].sha!,
              retry: true,
              maxRetries: 1,
            });
            return decodeBase64String(res.content);
          })(),
          await this.vault.adapter.read(normalizePath(filePath)),
        ]);
        return {
          filePath,
          remoteContent,
          localContent,
        };
      }),
    );
  }

  /**
   * Determines which sync action to take for each file.
   *
   * @param remoteFiles All files in the remote repo
   * @param localFiles All files in the local vault
   * @param conflictFiles List of paths to files that have conflict with remote
   *
   * @returns List of SyncActions
   */
  async determineSyncActions(
    remoteFiles: { [key: string]: FileMetadata },
    localFiles: { [key: string]: FileMetadata },
    conflictFiles: string[],
  ) {
    let actions: SyncAction[] = [];

    const commonFiles = Object.keys(remoteFiles)
      .filter((filePath) => filePath in localFiles)
      // Remove conflicting files, we determine their actions in a different way
      .filter((filePath) => !conflictFiles.contains(filePath))
      .filter((filePath) => !this.shouldSkipSyncPath(filePath));

    // Get diff for common files
    await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file must never trigger any action
          return;
        }

        const remoteFile = remoteFiles[filePath];
        const localFile = localFiles[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          // Nothing to do
          return;
        }

        const localSHA = await this.calculateSHA(filePath);

        if (remoteFile.deleted && !localFile.deleted) {
          if ((remoteFile.deletedAt as number) > localFile.lastModified) {
            actions.push({
              type: "delete_local",
              filePath: filePath,
            });
            return;
          } else if (
            localFile.lastModified > (remoteFile.deletedAt as number)
          ) {
            actions.push({ type: "upload", filePath: filePath });
            return;
          }
        }

        if (!remoteFile.deleted && localFile.deleted) {
          if (remoteFile.lastModified > (localFile.deletedAt as number)) {
            actions.push({ type: "download", filePath: filePath });
            return;
          } else if (
            (localFile.deletedAt as number) > remoteFile.lastModified
          ) {
            actions.push({
              type: "delete_remote",
              filePath: filePath,
            });
            return;
          }
        }

        if (remoteFile.sha === localSHA) {
          // If the remote file sha is identical to the actual sha of the local file
          // there are no actions to take.
          // We calculate the SHA at the moment instead of using the one stored in the
          // metadata file cause we update that only when the file is uploaded or downloaded.
          return;
        }

        // For non-deletion cases, if SHAs differ, we just need to check if local changed.
        // Conflicts are already filtered out so we can make this decision easily
        if (localSHA !== localFile.sha) {
          actions.push({ type: "upload", filePath: filePath });
          return;
        } else {
          actions.push({ type: "download", filePath: filePath });
          return;
        }
      }),
    );

    // Get diff for files in remote but not in local
    Object.keys(remoteFiles).forEach((filePath: string) => {
      if (this.shouldSkipSyncPath(filePath)) {
        return;
      }
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (localFile) {
        // Local file exists, we already handled it.
        // Skip it.
        return;
      }
      if (remoteFile.deleted) {
        // Remote is deleted but we don't have it locally.
        // Nothing to do.
        // TODO: Maybe we need to remove remote reference too?
      } else {
        actions.push({ type: "download", filePath: filePath });
      }
    });

    // Get diff for files in local but not in remote
    Object.keys(localFiles).forEach((filePath: string) => {
      if (this.shouldSkipSyncPath(filePath)) {
        return;
      }
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (remoteFile) {
        // Remote file exists, we already handled it.
        // Skip it.
        return;
      }
      if (localFile.deleted) {
        // Local is deleted and remote doesn't exist.
        // Just remove the local reference.
      } else {
        actions.push({ type: "upload", filePath: filePath });
      }
    });

    if (!this.settings.syncConfigDir) {
      // Remove all actions that involve the config directory if the user doesn't want to sync it.
      // The manifest file is always synced.
      return actions.filter((action: SyncAction) => {
        return (
          !action.filePath.startsWith(this.vault.configDir) ||
          action.filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
        );
      });
    }

    return actions;
  }

  /**
   * Calculates the SHA1 of a file given its content.
   * This is the same identical algoritm used by git to calculate
   * a blob's SHA.
   * @param filePath normalized path to file
   * @returns String containing the file SHA1 or null in case the file doesn't exist
   */
  async calculateSHA(filePath: string): Promise<string | null> {
    if (!(await this.vault.adapter.exists(filePath))) {
      // The file doesn't exist, can't calculate any SHA
      return null;
    }
    const contentBuffer = await this.vault.adapter.readBinary(filePath);
    const contentBytes = new Uint8Array(contentBuffer);
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array(header.length + contentBytes.length);
    store.set(header, 0);
    store.set(contentBytes, header.length);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  /**
   * Calculates git blob SHA1 from in-memory text content.
   * This is used for conflict resolutions where uploaded content can differ
   * from the current on-disk file until sync completes.
   */
  async calculateTextSHA(content: string): Promise<string> {
    const contentBytes = new TextEncoder().encode(content);
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array(header.length + contentBytes.length);
    store.set(header, 0);
    store.set(contentBytes, header.length);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  /**
   * Creates a new sync commit in the remote repository.
   *
   * @param treeFiles Updated list of files in the remote tree
   * @param baseTreeSha sha of the tree to use as base for the new tree
   * @param conflictResolutions list of conflicts between remote and local files
   */
  async commitSync(
    treeFiles: { [key: string]: NewTreeRequestItem },
    baseTreeSha: string,
    conflictResolutions: ConflictResolution[] = [],
  ) {
    const contentResolutions = conflictResolutions.filter(
      (resolution): resolution is ConflictResolution & { content: string } =>
        typeof resolution.content === "string",
    );

    // Update local sync time
    const syncTime = Date.now();
    this.metadataStore.data.lastSync = syncTime;
    await this.metadataStore.save();

    // We update the last modified timestamp for all files that had resolved conflicts
    // to the the same time as the sync time.
    // At this time we still have not written the conflict resolution content to file,
    // so the last modified timestamp doesn't reflect that.
    // To prevent further conflicts in future syncs and to reflect the content change
    // on the remote metadata we update the timestamp for the conflicting files here,
    // just before pushing to remote.
    // We're going to update the local content when the sync is successful.
    contentResolutions.forEach((resolution) => {
      this.metadataStore.data.files[resolution.filePath].lastModified =
        syncTime;
    });

    // We want the remote metadata file to track the correct SHA for each file blob,
    // so just before we upload any file we update all their SHAs in the metadata file.
    // This also makes it easier to handle conflicts.
    // We don't save the metadata file after setting the SHAs cause we do that when
    // the sync is fully commited at the end.
    // TODO: Understand whether it's a problem we don't revert the SHA setting in case of sync failure
    //
    // In here we also upload blob is file is a binary. We do it here because when uploading a blob we
    // also get back its SHA, so we can set it together with other files.
    // We also do that right before creating the new tree because we need the SHAs of those blob to
    // correctly create it.
    await Promise.all(
      Object.keys(treeFiles)
        .filter((filePath: string) => treeFiles[filePath].content)
        .map(async (filePath: string) => {
          // I don't fully trust file extensions as they're not completely reliable
          // to determine the file type, though I feel it's ok to compromise and rely
          // on them if it makes the plugin handle upload better on certain devices.
          if (hasTextExtension(filePath)) {
            const resolution = conflictResolutions.find(
              (item) => item.filePath === filePath,
            );
            const sha = resolution
              ? await this.calculateTextSHA(treeFiles[filePath].content!)
              : await this.calculateSHA(filePath);
            // Store current sha as ancestor before updating
            this.metadataStore.data.files[filePath].ancestorSha =
              this.metadataStore.data.files[filePath].sha;
            this.metadataStore.data.files[filePath].sha = sha;
            return;
          }

          // We can't upload binary files by setting the content of a tree item,
          // we first need to create a Git blob by uploading the file, then
          // we must update the tree item to point the SHA to the blob we just created.
          const buffer = await this.vault.adapter.readBinary(filePath);
          const { sha } = await this.client.createBlob({
            content: arrayBufferToBase64(buffer),
            retry: true,
            maxRetries: 3,
          });
          await this.logger.info("Created blob", filePath);
          treeFiles[filePath].sha = sha;
          // Can't have both sha and content set, so we delete it
          delete treeFiles[filePath].content;
          this.metadataStore.data.files[filePath].sha = sha;
        }),
    );

    // Update manifest in list of new tree items
    delete treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`].sha;
    treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`].content =
      JSON.stringify(this.metadataStore.data);

    // Create the new tree
    const newTree: { tree: NewTreeRequestItem[]; base_tree: string } = {
      tree: Object.keys(treeFiles).map(
        (filePath: string) => treeFiles[filePath],
      ),
      base_tree: baseTreeSha,
    };
    const newTreeSha = await this.client.createTree({
      tree: newTree,
      retry: true,
    });

    const branchHeadSha = await this.client.getBranchHeadSha({ retry: true });

    const commitSha = await this.client.createCommit({
      // TODO: Make this configurable or find a nicer commit message
      message: "Sync",
      treeSha: newTreeSha,
      parent: branchHeadSha,
    });

    try {
      await this.client.updateBranchHead({ sha: commitSha, retry: true });
    } catch (err) {
      if (err?.status === 422) {
        throw new BranchHeadAdvancedError(
          "Remote branch advanced while syncing",
        );
      }
      throw err;
    }

    // Update the local content of all files that had conflicts we resolved
    await Promise.all(
      contentResolutions.map(async (resolution) => {
        await this.vault.adapter.write(resolution.filePath, resolution.content);
        // Even though we set the last modified timestamp for all files with conflicts
        // just before pushing the changes to remote we do it here again because the
        // write right above would overwrite that.
        // Since we want to keep the sync timestamp for this file to avoid future conflicts
        // we update it again.
        this.metadataStore.data.files[resolution.filePath].lastModified =
          syncTime;
      }),
    );
    // Now that the sync is done and we updated the content for conflicting files
    // we can save the latest metadata to disk.
    await this.metadataStore.save();
    await this.logger.info("Sync done");
  }

  async downloadFile(file: GetTreeResponseItem, lastModified: number) {
    const fileMetadata = this.metadataStore.data.files[file.path];
    if (fileMetadata && fileMetadata.sha === file.sha) {
      // File already exists and has the same SHA, no need to download it again.
      return;
    }
    const blob = await this.client.getBlob({ sha: file.sha, retry: true });
    const normalizedPath = normalizePath(file.path);
    const fileFolder = normalizePath(
      normalizedPath.split("/").slice(0, -1).join("/"),
    );
    if (!(await this.vault.adapter.exists(fileFolder))) {
      await this.vault.adapter.mkdir(fileFolder);
    }
    await this.vault.adapter.writeBinary(
      normalizedPath,
      base64ToArrayBuffer(blob.content),
    );
    // Store current sha as ancestor before updating (enables diff3 on next conflict)
    const previousSha = this.metadataStore.data.files[file.path]?.sha || null;
    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: file.sha,
      dirty: false,
      justDownloaded: true,
      lastModified: lastModified,
      ancestorSha: previousSha || file.sha,
    };
    await this.metadataStore.save();
  }

  async deleteLocalFile(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    if (await this.vault.adapter.exists(normalizedPath)) {
      await this.vault.adapter.remove(normalizedPath);
    }
    if (!this.metadataStore.data.files[filePath]) {
      this.metadataStore.data.files[filePath] = {
        path: filePath,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
    }
    this.metadataStore.data.files[filePath].deleted = true;
    this.metadataStore.data.files[filePath].deletedAt = Date.now();
    await this.metadataStore.save();
  }

  async loadMetadata() {
    await this.logger.info("Loading metadata");
    await this.metadataStore.load();
    let cleaned = false;
    Object.keys(this.metadataStore.data.files).forEach((filePath) => {
      if (!this.isTrackablePath(filePath, true)) {
        delete this.metadataStore.data.files[filePath];
        cleaned = true;
      }
    });
    if (cleaned) {
      await this.metadataStore.save();
    }
    if (Object.keys(this.metadataStore.data.files).length === 0) {
      await this.logger.info("Metadata was empty, loading all files");
      let files = [];
      let folders = [this.vault.getRoot().path];
      while (folders.length > 0) {
        const folder = folders.pop();
        if (folder === undefined) {
          continue;
        }
        if (!this.settings.syncConfigDir && folder === this.vault.configDir) {
          await this.logger.info("Skipping config dir");
          // Skip the config dir if the user doesn't want to sync it
          continue;
        }
        const res = await this.vault.adapter.list(folder);
        files.push(...res.files);
        folders.push(...res.folders);
      }
      files.forEach((filePath: string) => {
        if (!this.isTrackablePath(filePath, false)) {
          return;
        }

        this.metadataStore.data.files[filePath] = {
          path: filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
      });

      // Must be the first time we run, initialize the metadata store
      // with itself and all files in the vault.
      this.metadataStore.data.files[
        `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
      ] = {
        path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
      await this.metadataStore.save();
    }
    await this.logger.info("Loaded metadata");
  }

  /**
   * Add all the files in the config dir in the metadata store.
   * This is mainly useful when the user changes the sync config settings
   * as we need to add those files to the metadata store or they would never be synced.
   */
  async addConfigDirToMetadata() {
    await this.logger.info("Adding config dir to metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }
    // Add them to the metadata store
    files.forEach((filePath: string) => {
      if (!this.isTrackablePath(filePath, false)) {
        return;
      }
      this.metadataStore.data.files[filePath] = {
        path: filePath,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
    });
    await this.metadataStore.save();
  }

  /**
   * Remove all the files in the config dir from the metadata store.
   * The metadata file is not removed as it must always be present.
   * This is mainly useful when the user changes the sync config settings
   * as we need to remove those files to the metadata store or they would
   * keep being synced.
   */
  async removeConfigDirFromMetadata() {
    await this.logger.info("Removing config dir from metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }

    // Remove all them from the metadata store
    files.forEach((filePath: string) => {
      if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
        // We don't want to remove the metadata file even if it's in the config dir
        return;
      }
      delete this.metadataStore.data.files[filePath];
    });
    await this.metadataStore.save();
  }

  getFileMetadata(filePath: string): FileMetadata {
    return this.metadataStore.data.files[filePath];
  }

  startEventsListener(plugin: GitHubSyncPlugin) {
    this.eventsListener.start(plugin);
  }

  /**
   * Starts a new sync interval.
   * Raises an error if the interval is already running.
   */
  startSyncInterval(minutes: number): number {
    if (this.syncIntervalId) {
      throw new Error("Sync interval is already running");
    }
    this.syncIntervalId = window.setInterval(
      async () => await this.sync(),
      // Sync interval is set in minutes but setInterval expects milliseconds
      minutes * 60 * 1000,
    );
    return this.syncIntervalId;
  }

  /**
   * Stops the currently running sync interval
   */
  stopSyncInterval() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    // Also clear push-on-save timer to prevent firing after unload
    if (this.pushOnSaveTimer !== null) {
      clearTimeout(this.pushOnSaveTimer);
      this.pushOnSaveTimer = null;
    }
  }

  /**
   * Util function that stops and restart the sync interval
   */
  restartSyncInterval(minutes: number) {
    this.stopSyncInterval();
    return this.startSyncInterval(minutes);
  }

  async resetMetadata() {
    this.metadataStore.reset();
    await this.metadataStore.save();
  }
}
