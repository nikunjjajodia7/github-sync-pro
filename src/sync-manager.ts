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
  ExplicitFolderDelete,
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GitHubSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import { decodeBase64String, hasTextExtension, StaleStateError } from "./utils";
import GitHubSyncPlugin from "./main";
import { BlobReader, Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { isTrackableSyncFolderPath, isTrackableSyncPath } from "./sync-scope";

interface SyncAction {
  type: "upload" | "download" | "delete_local" | "delete_remote";
  filePath: string;
}

type ReconcileDecisionType =
  | "noop"
  | "upload"
  | "download"
  | "delete_local"
  | "delete_remote"
  | "conflict";

interface PathState {
  path: string;
  localMetadata?: FileMetadata;
  remoteMetadata?: FileMetadata;
  remoteTree?: GetTreeResponseItem;
  actualLocalSha: string | null;
}

interface LocalSnapshot {
  metadataChanged: boolean;
  pathStates: { [key: string]: PathState };
}

interface RemoteSnapshot {
  explicitFolderDeletes: ExplicitFolderDelete[];
  metadata: Metadata;
  metadataChanged: boolean;
  treeFiles: { [key: string]: GetTreeResponseItem };
  treeSha: string;
}

interface ReconcileDecision {
  type: ReconcileDecisionType;
  filePath: string;
}

interface CommitPlan {
  actions: SyncAction[];
  baseTreeSha: string;
  confirmedDeletedFolders?: Set<string>;
  expectedHeadSha: string;
  conflictResolutions: ConflictResolution[];
  remoteDeletedFolders?: string[];
  treeFiles: { [key: string]: NewTreeRequestItem };
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

export default class SyncManager {
  private metadataStore: MetadataStore;
  private client: GithubClient;
  private eventsListener: EventsListener;
  private syncIntervalId: number | null = null;

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
  }

  private isTrackablePath(filePath: string, includeManifest: boolean = false): boolean {
    return isTrackableSyncPath(filePath, {
      configDir: this.vault.configDir,
      manifestPath: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
      logPath: `${this.vault.configDir}/${LOG_FILE_NAME}`,
      syncConfigDir: this.settings.syncConfigDir,
      syncScopeMode: this.settings.syncScopeMode,
      includeManifest,
    });
  }

  private shouldSkipSyncPath(filePath: string): boolean {
    return !this.isTrackablePath(filePath, false);
  }

  private hasFileLikeExtension(path: string): boolean {
    const leaf = path.split("/").pop() ?? path;
    return /\.(md|txt|csv|json|png|jpg|jpeg|webp|gif|svg|pdf|mp3|m4a|wav|webm|mp4)$/i.test(
      leaf,
    );
  }

  private isEnoentError(err: unknown): boolean {
    if (!(err instanceof Error)) {
      return false;
    }
    const code = (err as Error & { code?: string }).code;
    return code === "ENOENT" || err.message.includes("ENOENT");
  }

  private sanitizeDeletedFolders(
    deletedFolders?: string[],
    metadataFiles: { [key: string]: FileMetadata } = this.metadataStore.data.files,
  ): string[] {
    if (!deletedFolders || deletedFolders.length === 0) {
      return [];
    }

    const unique = new Set<string>();
    const sanitized: string[] = [];

    for (const rawPath of deletedFolders) {
      const folderPath = normalizePath(rawPath ?? "");
      if (!folderPath || unique.has(folderPath)) {
        continue;
      }

      const hasTrackedChildren = Object.keys(metadataFiles).some(
        (filePath) => filePath.startsWith(`${folderPath}/`),
      );
      const isProbableFilePath =
        !hasTrackedChildren &&
        this.hasFileLikeExtension(folderPath);

      if (
        isProbableFilePath ||
        !isTrackableSyncFolderPath(folderPath, {
          configDir: this.vault.configDir,
          syncConfigDir: this.settings.syncConfigDir,
        })
      ) {
        void this.logger.warn("Dropping invalid deletedFolders entry", {
          folderPath,
          reason: isProbableFilePath ? "probable_file_path" : "non_trackable",
        });
        continue;
      }

      unique.add(folderPath);
      sanitized.push(folderPath);
    }

    return sanitized;
  }

  private getExplicitFolderDeletes(metadata: Metadata): ExplicitFolderDelete[] {
    const deletedFolders = this.sanitizeDeletedFolders(
      metadata.deletedFolders,
      metadata.files,
    );

    return deletedFolders.map((folderPath) => ({
      path: folderPath,
      deletedAt: null,
    }));
  }

  private filterExplicitFolderDeletes(
    deletedFolders: ExplicitFolderDelete[],
    metadataFiles: { [key: string]: FileMetadata },
    treeFiles: { [key: string]: { path?: string } } = {},
  ): ExplicitFolderDelete[] {
    return deletedFolders.filter((folder) => {
      const hasLiveRemoteDescendant = Object.keys(treeFiles).some((filePath) =>
        filePath.startsWith(`${folder.path}/`),
      );
      const hasLiveMetadataDescendant = Object.entries(metadataFiles).some(
        ([filePath, meta]) =>
          filePath.startsWith(`${folder.path}/`) && !meta.deleted,
      );
      return !hasLiveRemoteDescendant && !hasLiveMetadataDescendant;
    });
  }

  private async applyExplicitFolderDeleteIntents(
    remoteMetadata: Metadata,
    remoteTreeFiles: { [key: string]: GetTreeResponseItem },
  ): Promise<{
    explicitFolderDeletes: ExplicitFolderDelete[];
    metadataChanged: boolean;
  }> {
    const initialDeletedFolders = JSON.stringify(
      this.sanitizeDeletedFolders(remoteMetadata.deletedFolders, remoteMetadata.files),
    );
    const explicitFolderDeletes = this.filterExplicitFolderDeletes(
      this.getExplicitFolderDeletes(remoteMetadata),
      remoteMetadata.files,
      remoteTreeFiles,
    );
    let metadataChanged = false;
    if (explicitFolderDeletes.length === 0) {
      if (remoteMetadata.deletedFolders !== undefined) {
        delete remoteMetadata.deletedFolders;
        metadataChanged = true;
      }
      return { explicitFolderDeletes: [], metadataChanged };
    }

    const now = Date.now();

    for (const folder of explicitFolderDeletes) {
      const folderPath = folder.path;
      const trackedDescendants = new Set<string>();

      Object.keys(remoteMetadata.files).forEach((filePath) => {
        if (filePath.startsWith(`${folderPath}/`)) {
          trackedDescendants.add(filePath);
        }
      });
      Object.keys(this.metadataStore.data.files).forEach((filePath) => {
        if (
          filePath.startsWith(`${folderPath}/`) &&
          this.isTrackablePath(filePath, true)
        ) {
          trackedDescendants.add(filePath);
        }
      });

      for (const filePath of trackedDescendants) {
        if (this.shouldSkipSyncPath(filePath)) {
          continue;
        }
        if (remoteTreeFiles[filePath]) {
          continue;
        }

        const existing = remoteMetadata.files[filePath];
        if (existing) {
          if (!existing.deleted) {
            existing.deleted = true;
            existing.deletedAt = existing.deletedAt ?? now;
            metadataChanged = true;
          }
          continue;
        }

        remoteMetadata.files[filePath] = {
          path: filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: now,
          deleted: true,
          deletedAt: now,
        };
        metadataChanged = true;
      }
    }

    remoteMetadata.deletedFolders = explicitFolderDeletes.map((folder) => folder.path);
    if (
      initialDeletedFolders !== JSON.stringify(remoteMetadata.deletedFolders ?? [])
    ) {
      metadataChanged = true;
    }
    await this.logger.info("Expanded explicit folder delete intents into tracked file tombstones", {
      folderCount: explicitFolderDeletes.length,
    });
    return { explicitFolderDeletes, metadataChanged };
  }

  private async buildRemoteSnapshot(): Promise<RemoteSnapshot> {
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const manifest = files[manifestPath];

    if (Object.keys(files).contains(`${this.vault.configDir}/${LOG_FILE_NAME}`)) {
      delete files[`${this.vault.configDir}/${LOG_FILE_NAME}`];
    }

    let remoteMetadata: Metadata;
    let metadataChanged = false;

    if (manifest === undefined) {
      await this.logger.warn(
        "Remote manifest missing, creating from tree state",
        { fileCount: Object.keys(files).length },
      );
      new Notice(
        "No sync manifest found. Creating one from current repo state. Some sync history may be lost.",
      );
      remoteMetadata = { lastSync: 0, files: {} };
      Object.keys(files).forEach((filePath: string) => {
        if (this.shouldSkipSyncPath(filePath)) return;
        remoteMetadata.files[filePath] = {
          path: filePath,
          sha: files[filePath].sha,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
      });
      metadataChanged = true;
    } else {
      const blob = await this.client.getBlob({ sha: manifest.sha });
      remoteMetadata = JSON.parse(decodeBase64String(blob.content));
      if (!remoteMetadata.files) {
        remoteMetadata.files = {};
      }
    }

    const {
      explicitFolderDeletes,
      metadataChanged: explicitFolderDeleteMetadataChanged,
    } = await this.applyExplicitFolderDeleteIntents(
      remoteMetadata,
      files,
    );
    if (explicitFolderDeleteMetadataChanged) {
      metadataChanged = true;
    }

    Object.keys(files).forEach((filePath: string) => {
      if (this.shouldSkipSyncPath(filePath)) {
        return;
      }
      const treeFile = files[filePath];
      const metadataFile = remoteMetadata.files[filePath];
      if (metadataFile) {
        if (metadataFile.sha !== treeFile.sha) {
          metadataFile.lastModified = Date.now();
          metadataChanged = true;
        }
        metadataFile.sha = treeFile.sha;
        if (metadataFile.deleted) {
          metadataFile.deleted = false;
          delete metadataFile.deletedAt;
          metadataChanged = true;
        }
      } else {
        remoteMetadata.files[filePath] = {
          path: filePath,
          sha: treeFile.sha,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
        metadataChanged = true;
      }
    });

    Object.keys(remoteMetadata.files).forEach((filePath: string) => {
      if (this.shouldSkipSyncPath(filePath)) {
        return;
      }
      if (!files[filePath] && !remoteMetadata.files[filePath].deleted) {
        remoteMetadata.files[filePath].deleted = true;
        remoteMetadata.files[filePath].deletedAt = Date.now();
        metadataChanged = true;
      }
    });

    return {
      explicitFolderDeletes,
      metadata: remoteMetadata,
      metadataChanged,
      treeFiles: files,
      treeSha,
    };
  }

  private async buildLocalSnapshot(
    remoteSnapshot: RemoteSnapshot,
  ): Promise<LocalSnapshot> {
    let metadataChanged = false;

    const removedEntries = await this.cleanupUntrackableMetadataEntries();
    if (removedEntries > 0) {
      metadataChanged = true;
    }

    const reconciledEntries = await this.reconcileMissingLocalMetadataEntries();
    if (reconciledEntries > 0) {
      metadataChanged = true;
    }

    const hydratedEntries = await this.hydrateMissingBaselines(
      remoteSnapshot.treeFiles,
      remoteSnapshot.metadata.files,
    );
    if (hydratedEntries > 0) {
      metadataChanged = true;
    }

    return {
      metadataChanged,
      pathStates: await this.buildPathStates(
        remoteSnapshot.metadata.files,
        remoteSnapshot.treeFiles,
        this.metadataStore.data.files,
      ),
    };
  }

  private async buildPathStates(
    remoteFiles: { [key: string]: FileMetadata },
    remoteTreeFiles: { [key: string]: GetTreeResponseItem },
    localFiles: { [key: string]: FileMetadata },
  ): Promise<{ [key: string]: PathState }> {
    const pathStates: { [key: string]: PathState } = {};
    const allPaths = new Set<string>([
      ...Object.keys(remoteFiles),
      ...Object.keys(remoteTreeFiles),
      ...Object.keys(localFiles),
    ]);

    await Promise.all(
      Array.from(allPaths).map(async (filePath) => {
        if (
          this.shouldSkipSyncPath(filePath) ||
          filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
        ) {
          return;
        }

        pathStates[filePath] = {
          path: filePath,
          localMetadata: localFiles[filePath],
          remoteMetadata: remoteFiles[filePath],
          remoteTree: remoteTreeFiles[filePath],
          actualLocalSha: await this.calculateSHA(filePath),
        };
      }),
    );

    return pathStates;
  }

  private async planReconciliation(
    remoteFiles: { [key: string]: FileMetadata },
    localFiles: { [key: string]: FileMetadata },
  ): Promise<{
    conflicts: ConflictFile[];
    decisions: ReconcileDecision[];
  }> {
    const conflicts = await this.findConflicts(remoteFiles);
    const actions = await this.determineSyncActions(
      remoteFiles,
      localFiles,
      conflicts.map((conflict) => conflict.filePath),
    );
    const decisions: ReconcileDecision[] = actions.map((action) => ({
      type: action.type,
      filePath: action.filePath,
    }));
    return { conflicts, decisions };
  }

  private async executeLocalPlan(
    actions: SyncAction[],
    remoteTreeFiles: { [key: string]: GetTreeResponseItem },
    remoteMetadataFiles: { [key: string]: FileMetadata },
  ) {
    await Promise.all([
      ...actions
        .filter((action) => action.type === "download")
        .map(async (action: SyncAction) => {
          await this.downloadFile(
            remoteTreeFiles[action.filePath],
            remoteMetadataFiles[action.filePath]
              ? remoteMetadataFiles[action.filePath].lastModified
              : Date.now(),
          );
          this.eventsListener.syncWrittenPaths.set(
            action.filePath,
            remoteTreeFiles[action.filePath]?.sha ?? null,
          );
        }),
      ...actions
        .filter((action) => action.type === "delete_local")
        .map(async (action: SyncAction) => {
          const meta = this.metadataStore.data.files[action.filePath];
          if (meta?.deleted) {
            await this.logger.info(
              "Skipping delete_local for already deleted metadata entry",
              action.filePath,
            );
            return;
          }
          await this.deleteLocalFile(action.filePath);
        }),
    ]);
  }

  private async applyExplicitFolderDeletes(
    explicitFolderDeletes: ExplicitFolderDelete[],
  ): Promise<Set<string>> {
    const removedFolders = new Set<string>();

    for (const folder of explicitFolderDeletes) {
      const normalizedPath = normalizePath(folder.path);
      if (!(await this.vault.adapter.exists(normalizedPath))) {
        removedFolders.add(folder.path);
        continue;
      }

      await this.removeDirectoryRecursive(normalizedPath, { force: false });
      if (!(await this.vault.adapter.exists(normalizedPath))) {
        removedFolders.add(folder.path);
      } else {
        await this.logger.info(
          "Explicit folder delete preserved remaining descendants",
          folder.path,
        );
      }
    }

    return removedFolders;
  }

  private buildManifestDeletedFolders(
    metadataFiles: { [key: string]: FileMetadata },
    treeFiles: { [key: string]: { path?: string } },
    remoteDeletedFolders: string[] = [],
    confirmedDeletedFolders: Set<string> = new Set(),
  ): string[] {
    const pendingFolders = [
      ...this.sanitizeDeletedFolders(
        this.metadataStore.data.deletedFolders,
        this.metadataStore.data.files,
      ),
      ...remoteDeletedFolders.filter(
        (folderPath) => !confirmedDeletedFolders.has(folderPath),
      ),
    ];

    const uniqueFolders = Array.from(new Set(pendingFolders)).map((folderPath) => ({
      path: folderPath,
      deletedAt: null,
    }));

    return this.filterExplicitFolderDeletes(
      uniqueFolders,
      metadataFiles,
      treeFiles,
    ).map((folder) => folder.path);
  }

  private buildInitialCommitTree(
    treeFiles: { [key: string]: GetTreeResponseItem },
  ): { [key: string]: NewTreeRequestItem } {
    return Object.keys(treeFiles)
      .map((filePath: string) => ({
        path: treeFiles[filePath].path,
        mode: treeFiles[filePath].mode,
        type: treeFiles[filePath].type,
        sha: treeFiles[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
  }

  private async commitRemotePlan(plan: CommitPlan) {
    await Promise.all(
      plan.actions.map(async (action) => {
        switch (action.type) {
          case "upload": {
            const normalizedPath = normalizePath(action.filePath);
            if (!(await this.vault.adapter.exists(normalizedPath))) {
              await this.logger.warn(
                "Skipping upload for missing file",
                action.filePath,
              );
              break;
            }
            const resolution = plan.conflictResolutions.find(
              (item) => item.filePath === action.filePath,
            );
            let content = resolution?.content;
            if (!content) {
              content = hasTextExtension(normalizedPath)
                ? await this.vault.adapter.read(normalizedPath)
                : "binaryfile";
            }
            plan.treeFiles[action.filePath] = {
              path: action.filePath,
              mode: "100644",
              type: "blob",
              content,
            };
            break;
          }
          case "delete_remote": {
            plan.treeFiles[action.filePath] = {
              path: action.filePath,
              mode: "100644",
              type: "blob",
              sha: null,
            };
            break;
          }
          case "download":
          case "delete_local":
            break;
        }
      }),
    );

    await this.commitSync(
      plan.treeFiles,
      plan.baseTreeSha,
      plan.conflictResolutions,
      plan.expectedHeadSha,
      plan.remoteDeletedFolders,
      plan.confirmedDeletedFolders,
    );
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
    } catch (err) {
      this.syncing = false;
      throw err;
    }
    this.syncing = false;
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
        this.syncing = false;
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
        };
        await this.metadataStore.save();
      }),
    );

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

    // Pause event listener during sync to prevent race conditions
    // between programmatic file writes and user edits.
    this.eventsListener.pause();

    const MAX_STALE_RETRIES = 3;
    try {
      for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
        try {
          await this.syncImpl();
          // Shown only if sync doesn't fail
          new Notice("Sync successful", 5000);
          break;
        } catch (err) {
          if (err instanceof StaleStateError && attempt < MAX_STALE_RETRIES) {
            await this.logger.warn(
              `Stale state detected (attempt ${attempt + 1}/${MAX_STALE_RETRIES}), retrying sync from scratch`,
            );
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof StaleStateError) {
        new Notice(
          "Sync failed — another device is syncing simultaneously. Try again in a moment.",
        );
      } else {
        // Show the error to the user, it's not automatically dismissed to make sure
        // the user sees it.
        new Notice(`Error syncing. ${err}`);
      }
    } finally {
      // Always resume event listener, even if sync failed
      this.eventsListener.resume();
      this.syncing = false;
      notice.hide();
    }
  }

  private async syncImpl() {
    await this.logger.info("Starting sync");

    // Capture HEAD SHA at the start of sync for staleness detection.
    // If HEAD moves before we update the branch ref, another device pushed
    // a commit and we must re-sync from scratch to avoid dropping files.
    const initialHeadSha = await this.client.getBranchHeadSha({ retry: true });

    const remoteSnapshot = await this.buildRemoteSnapshot();
    const localSnapshot = await this.buildLocalSnapshot(remoteSnapshot);
    const { conflicts, decisions } = await this.planReconciliation(
      remoteSnapshot.metadata.files,
      this.metadataStore.data.files,
    );
    const hasLocalDeletedFolders =
      this.sanitizeDeletedFolders(
        this.metadataStore.data.deletedFolders,
        this.metadataStore.data.files,
      ).length > 0;

    // We treat every resolved conflict as an upload SyncAction, mainly cause
    // the user has complete freedom on the edits they can apply to the conflicting files.
    // So when a conflict is resolved we change the file locally and upload it.
    // That solves the conflict.
    let conflictActions: SyncAction[] = [];
    // We keep track of the conflict resolutions cause we want to update the file
    // locally only when we're sure the sync was successul. That happens after we
    // commit the sync.
    let conflictResolutions: ConflictResolution[] = [];

    if (conflicts.length > 0) {
      await this.logger.warn("Found conflicts", conflicts);
      if (this.settings.conflictHandling === "ask") {
        // Separate binary and text conflicts — binary can't use the diff UI
        const textConflicts = conflicts.filter((c) =>
          hasTextExtension(c.filePath),
        );
        const binaryConflicts = conflicts.filter(
          (c) => !hasTextExtension(c.filePath),
        );

        // Auto-resolve binary conflicts as downloads (keep remote version)
        if (binaryConflicts.length > 0) {
          conflictActions.push(
            ...binaryConflicts.map((c) => ({
              type: "download" as const,
              filePath: c.filePath,
            })),
          );
        }

        // Ask user to resolve text conflicts
        if (textConflicts.length > 0) {
          conflictResolutions = await this.onConflicts(textConflicts);
          conflictActions.push(
            ...conflictResolutions.map(
              (resolution: ConflictResolution) => ({
                type: "upload" as const,
                filePath: resolution.filePath,
              }),
            ),
          );
        }
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        // The user explicitly wants to always overwrite the local file
        // in case of conflicts so we just download the remote file to solve it

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the remote file with no changes.
        conflictActions = conflicts.map((conflict: ConflictFile) => {
          return { type: "download", filePath: conflict.filePath };
        });
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        // The user explicitly wants to always overwrite the remote file
        // in case of conflicts so we just upload the remote file to solve it.

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the local file with no changes.
        conflictActions = conflicts.map((conflict: ConflictFile) => {
          return { type: "upload", filePath: conflict.filePath };
        });
      }
    }

    const actions: SyncAction[] = [
      ...decisions
        .filter((decision) => decision.type !== "noop" && decision.type !== "conflict")
        .map((decision) => ({
          type: decision.type as SyncAction["type"],
          filePath: decision.filePath,
        })),
      ...conflictActions,
    ];

    let confirmedDeletedFolders = await this.applyExplicitFolderDeletes(
      remoteSnapshot.explicitFolderDeletes,
    );

    if (actions.length === 0) {
      if (
        remoteSnapshot.metadataChanged ||
        localSnapshot.metadataChanged ||
        hasLocalDeletedFolders ||
        confirmedDeletedFolders.size > 0
      ) {
        await this.logger.info(
          "No file actions to sync, committing metadata updates only",
          {
            remoteMetadataChanged: remoteSnapshot.metadataChanged,
            localMetadataChanged: localSnapshot.metadataChanged,
            hasLocalDeletedFolders,
            confirmedDeletedFolders: Array.from(confirmedDeletedFolders),
          },
        );
        await this.commitRemotePlan({
          actions: [],
          baseTreeSha: remoteSnapshot.treeSha,
          confirmedDeletedFolders,
          expectedHeadSha: initialHeadSha,
          conflictResolutions: [],
          remoteDeletedFolders: remoteSnapshot.explicitFolderDeletes.map(
            (folder) => folder.path,
          ),
          treeFiles: this.buildInitialCommitTree(remoteSnapshot.treeFiles),
        });
        return;
      }
      // Nothing to sync
      await this.logger.info("Nothing to sync");
      return;
    }
    await this.logger.info("Actions to sync", actions);

    await this.executeLocalPlan(
      actions,
      remoteSnapshot.treeFiles,
      remoteSnapshot.metadata.files,
    );
    const postActionConfirmedDeletedFolders = await this.applyExplicitFolderDeletes(
      remoteSnapshot.explicitFolderDeletes,
    );
    confirmedDeletedFolders = new Set([
      ...confirmedDeletedFolders,
      ...postActionConfirmedDeletedFolders,
    ]);

    await this.commitRemotePlan({
      actions,
      baseTreeSha: remoteSnapshot.treeSha,
      confirmedDeletedFolders,
      expectedHeadSha: initialHeadSha,
      conflictResolutions,
      remoteDeletedFolders: remoteSnapshot.explicitFolderDeletes.map(
        (folder) => folder.path,
      ),
      treeFiles: this.buildInitialCommitTree(remoteSnapshot.treeFiles),
    });
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

  private async reconcileMissingLocalMetadataEntries(): Promise<number> {
    const reconciledPaths: string[] = [];
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const logPath = `${this.vault.configDir}/${LOG_FILE_NAME}`;

    for (const [filePath, meta] of Object.entries(this.metadataStore.data.files)) {
      if (filePath === manifestPath || filePath === logPath || meta.deleted) {
        continue;
      }

      if (!(await this.vault.adapter.exists(normalizePath(filePath)))) {
        meta.deleted = true;
        meta.deletedAt = meta.deletedAt ?? Date.now();
        meta.dirty = false;
        meta.justDownloaded = false;
        reconciledPaths.push(filePath);
      }
    }

    if (reconciledPaths.length > 0) {
      await this.metadataStore.save();
      await this.logger.warn("Reconciled missing local metadata entries", {
        count: reconciledPaths.length,
        sample: reconciledPaths.slice(0, 5),
      });
    }

    return reconciledPaths.length;
  }

  /**
   * Finds conflicts between local and remote files.
   * @param filesMetadata Remote files metadata
   * @returns List of object containing file path, remote and local content of conflicting files
   */
  async findConflicts(filesMetadata: {
    [key: string]: FileMetadata;
  }): Promise<ConflictFile[]> {
    const pathStates = await this.buildPathStates(
      filesMetadata,
      Object.fromEntries(
        Object.entries(filesMetadata)
          .filter(([, file]) => file.sha !== null)
          .map(([filePath, file]) => [
            filePath,
            {
              path: filePath,
              mode: "100644",
              type: "blob",
              sha: file.sha!,
              size: 0,
              url: "",
            } satisfies GetTreeResponseItem,
          ]),
      ),
      this.metadataStore.data.files,
    );

    const commonFiles = Object.keys(pathStates);
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
        const state = pathStates[filePath];
        const remoteFile = state.remoteMetadata;
        const localFile = state.localMetadata;
        if (!remoteFile || !localFile) {
          return null;
        }
        if (remoteFile.deleted && localFile.deleted) {
          return null;
        }
        const actualLocalSHA = state.actualLocalSha;
        if (actualLocalSHA === null) {
          return null;
        }
        if (localFile.sha === null || remoteFile.sha === null) {
          return remoteFile.deleted || remoteFile.sha === actualLocalSHA
            ? null
            : filePath;
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
    const binaryConflictPaths = conflictPaths.filter(
      (filePath) => !hasTextExtension(filePath),
    );
    if (
      this.settings.conflictHandling === "ask" &&
      binaryConflictPaths.length > 0
    ) {
      // Binary conflicts can't be shown in the text diff UI, so we auto-resolve
      // by keeping the remote version (download) and notifying the user.
      await this.logger.warn(
        "Binary conflicts auto-resolved by downloading remote version",
        binaryConflictPaths,
      );
      for (const binaryPath of binaryConflictPaths) {
        new Notice(
          `Binary conflict on '${binaryPath.split("/").pop()}' — kept the remote version. Re-upload locally if needed.`,
        );
      }
      // Remove binary paths from conflict list — they'll be handled as downloads
      // by returning them with empty content (existing behavior below handles this)
    }

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

  private reconcilePath(
    pathState: PathState,
    conflictFiles: Set<string>,
  ): ReconcileDecision {
    const filePath = pathState.path;
    if (
      filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}` ||
      this.shouldSkipSyncPath(filePath)
    ) {
      return { type: "noop", filePath };
    }
    if (conflictFiles.has(filePath)) {
      return { type: "conflict", filePath };
    }

    const remoteFile = pathState.remoteMetadata;
    const localFile = pathState.localMetadata;
    const localSHA = pathState.actualLocalSha;

    if (remoteFile && localFile) {
      if (remoteFile.deleted && localFile.deleted) {
        return { type: "noop", filePath };
      }

      if (remoteFile.deleted && !localFile.deleted) {
        const localWasEdited = localSHA !== null && localSHA !== localFile.sha;
        if (localWasEdited) {
          new Notice(
            `'${filePath.split("/").pop()}' was deleted on another device but has local edits. Kept the local version.`,
          );
          return { type: "upload", filePath };
        }
        return { type: "delete_local", filePath };
      }

      if (!remoteFile.deleted && localFile.deleted) {
        const remoteWasEdited =
          localFile.sha !== null && remoteFile.sha !== localFile.sha;
        if (remoteWasEdited) {
          new Notice(
            `'${filePath.split("/").pop()}' was deleted locally but has remote edits. Restored the remote version.`,
          );
          return { type: "download", filePath };
        }
        return { type: "delete_remote", filePath };
      }

      if (remoteFile.sha === localSHA) {
        return { type: "noop", filePath };
      }

      return localSHA !== localFile.sha
        ? { type: "upload", filePath }
        : { type: "download", filePath };
    }

    if (remoteFile && !localFile) {
      return remoteFile.deleted
        ? { type: "noop", filePath }
        : { type: "download", filePath };
    }

    if (!remoteFile && localFile) {
      return localFile.deleted
        ? { type: "noop", filePath }
        : { type: "upload", filePath };
    }

    return { type: "noop", filePath };
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
    const pathStates = await this.buildPathStates(remoteFiles, {}, localFiles);
    const conflicts = new Set(conflictFiles);
    const actions = Object.values(pathStates)
      .map((state) => this.reconcilePath(state, conflicts))
      .filter(
        (decision) => decision.type !== "noop" && decision.type !== "conflict",
      )
      .map((decision) => ({
        type: decision.type as SyncAction["type"],
        filePath: decision.filePath,
      }));

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
    const store = new Uint8Array([...header, ...contentBytes]);
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
    const store = new Uint8Array([...header, ...contentBytes]);
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
    expectedHeadSha?: string,
    remoteDeletedFolders: string[] = [],
    confirmedDeletedFolders: Set<string> = new Set(),
  ) {
    // Sync timestamp — used for manifest snapshot but NOT applied to live
    // metadataStore until after commit succeeds (deferred writes pattern).
    const syncTime = Date.now();

    // Deferred writes: accumulate SHA updates in a pending map instead of
    // modifying metadataStore.data directly. Only apply after commit succeeds.
    // This prevents stale metadata if any API call fails mid-pipeline.
    const pendingSHAs: { [filePath: string]: string | null } = {};

    await Promise.all(
      Object.keys(treeFiles)
        .filter((filePath: string) => treeFiles[filePath].content)
        .map(async (filePath: string) => {
          if (hasTextExtension(filePath)) {
            const resolution = conflictResolutions.find(
              (item) => item.filePath === filePath,
            );
            const sha = resolution
              ? await this.calculateTextSHA(treeFiles[filePath].content!)
              : await this.calculateSHA(filePath);
            pendingSHAs[filePath] = sha;
            return;
          }

          // Binary files: upload blob, get SHA back
          const buffer = await this.vault.adapter.readBinary(filePath);
          const { sha } = await this.client.createBlob({
            content: arrayBufferToBase64(buffer),
            retry: true,
            maxRetries: 3,
          });
          await this.logger.info("Created blob", filePath);
          treeFiles[filePath].sha = sha;
          delete treeFiles[filePath].content;
          pendingSHAs[filePath] = sha;
        }),
    );

    // Build manifest content for the remote by merging pending SHAs into
    // a copy of the current metadata (without mutating the live store).
    const manifestSnapshot = JSON.parse(
      JSON.stringify(this.metadataStore.data),
    );
    manifestSnapshot.lastSync = syncTime;
    for (const [fp, sha] of Object.entries(pendingSHAs)) {
      if (manifestSnapshot.files[fp]) {
        manifestSnapshot.files[fp].sha = sha;
      }
    }
    conflictResolutions.forEach((resolution) => {
      if (manifestSnapshot.files[resolution.filePath]) {
        manifestSnapshot.files[resolution.filePath].lastModified = syncTime;
      }
    });
    const liveTreeFiles = Object.fromEntries(
      Object.entries(treeFiles).filter(([, item]) => item.sha !== null || item.content),
    );
    const remainingExplicitFolderDeletes = this.buildManifestDeletedFolders(
      manifestSnapshot.files,
      liveTreeFiles,
      remoteDeletedFolders,
      confirmedDeletedFolders,
    );
    manifestSnapshot.deletedFolders =
      remainingExplicitFolderDeletes.length > 0
        ? remainingExplicitFolderDeletes
        : undefined;

    // Update manifest in list of new tree items
    delete treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`].sha;
    treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`].content =
      JSON.stringify(manifestSnapshot);

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

    // Staleness check: if expectedHeadSha was provided (from incremental sync),
    // verify the branch HEAD hasn't moved since we started.
    if (expectedHeadSha && branchHeadSha !== expectedHeadSha) {
      throw new StaleStateError(expectedHeadSha, branchHeadSha);
    }

    const commitSha = await this.client.createCommit({
      // TODO: Make this configurable or find a nicer commit message
      message: "Sync",
      treeSha: newTreeSha,
      parent: branchHeadSha,
      retry: true,
    });

    await this.client.updateBranchHead({ sha: commitSha, retry: true });

    // ── Commit succeeded — now apply deferred state to live metadata ──

    // Apply sync timestamp
    this.metadataStore.data.lastSync = syncTime;

    // Apply pending SHAs
    for (const [fp, sha] of Object.entries(pendingSHAs)) {
      if (this.metadataStore.data.files[fp]) {
        this.metadataStore.data.files[fp].sha = sha;
      }
    }

    // Write conflict resolution content to local files and update timestamps
    await Promise.all(
      conflictResolutions.map(async (resolution) => {
        await this.vault.adapter.write(resolution.filePath, resolution.content);
        if (this.metadataStore.data.files[resolution.filePath]) {
          this.metadataStore.data.files[resolution.filePath].lastModified =
            syncTime;
        }
      }),
    );

    delete this.metadataStore.data.deletedFolders;

    // Purge stale tombstones: deleted entries whose parent folder no longer
    // exists locally. These have served their purpose — the deletion has been
    // propagated. Keeping them wastes cycles on every sync.
    const allPaths = Object.keys(this.metadataStore.data.files);
    for (const filePath of allPaths) {
      const meta = this.metadataStore.data.files[filePath];
      if (!meta.deleted) continue;
      const topFolder = filePath.split("/")[0];
      const topFolderExists = await this.vault.adapter.exists(
        normalizePath(topFolder),
      );
      if (!topFolderExists) {
        delete this.metadataStore.data.files[filePath];
      }
    }

    // Save the fully updated metadata to disk
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
    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: file.sha,
      dirty: false,
      justDownloaded: true,
      lastModified: lastModified,
    };
    await this.metadataStore.save();
  }

  async deleteLocalFile(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    const meta = this.metadataStore.data.files[filePath];
    if (!meta) {
      return;
    }

    const exists = await this.vault.adapter.exists(normalizedPath);
    if (exists) {
      try {
        await this.vault.adapter.remove(normalizedPath);
      } catch (err) {
        if (!this.isEnoentError(err)) {
          throw err;
        }
        await this.logger.warn(
          "Local file disappeared during delete_local, treating as already deleted",
          filePath,
        );
      }
    } else {
      await this.logger.info(
        "Local file already missing during delete_local, tombstoning metadata",
        filePath,
      );
    }

    meta.deleted = true;
    meta.deletedAt = meta.deletedAt ?? Date.now();
    meta.dirty = false;
    meta.justDownloaded = false;
    await this.metadataStore.save();
  }

  /**
   * Recursively removes a directory and all its empty subdirectories.
   * Only removes directories that contain no files — if any file still
   * exists inside, the directory tree is left intact.
   * Works bottom-up: removes deepest subdirectories first, then parents.
   */
  private async removeDirectoryRecursive(
    dirPath: string,
    options: { force?: boolean } = {},
  ) {
    try {
      const { files, folders } = await this.vault.adapter.list(dirPath);

      if (options.force) {
        for (const filePath of files) {
          await this.vault.adapter.remove(filePath);
          await this.logger.info(
            "Removed leftover file while deleting folder from remote tombstone",
            filePath,
          );
        }
      }

      // First, recursively process subdirectories
      for (const subFolder of folders) {
        await this.removeDirectoryRecursive(subFolder, options);
      }

      // Re-check after subdirectory cleanup
      const after = await this.vault.adapter.list(dirPath);
      if (after.files.length === 0 && after.folders.length === 0) {
        await this.vault.adapter.rmdir(dirPath, false);
        await this.logger.info(
          "Removed folder deleted on another device",
          dirPath,
        );
      } else if (options.force) {
        await this.vault.adapter.rmdir(dirPath, true);
        await this.logger.info(
          "Force removed folder deleted on another device",
          dirPath,
        );
      } else {
        await this.logger.warn(
          "Folder not empty after cleanup, keeping it",
          {
            dirPath,
            files: after.files,
            folders: after.folders,
          },
        );
      }
    } catch {
      // Directory might not exist or already been removed
    }
  }

  async loadMetadata() {
    await this.logger.info("Loading metadata");
    await this.metadataStore.load();
    let cleaned = false;

    const sanitizedDeletedFolders = this.sanitizeDeletedFolders(
      this.metadataStore.data.deletedFolders,
    );
    if (
      JSON.stringify(sanitizedDeletedFolders) !==
      JSON.stringify(this.metadataStore.data.deletedFolders ?? [])
    ) {
      this.metadataStore.data.deletedFolders = sanitizedDeletedFolders;
      cleaned = true;
    }

    Object.keys(this.metadataStore.data.files).forEach((filePath) => {
      if (!this.isTrackablePath(filePath, true)) {
        delete this.metadataStore.data.files[filePath];
        cleaned = true;
      }
    });

    // Normalize: clear dirty flag on deleted entries. deleted+dirty is an
    // inconsistent state that serves no purpose — deleted files never generate
    // upload actions regardless of the dirty flag.
    for (const meta of Object.values(this.metadataStore.data.files)) {
      if (meta.deleted && meta.dirty) {
        meta.dirty = false;
        cleaned = true;
      }
    }
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
