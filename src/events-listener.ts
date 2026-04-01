import { Vault, TAbstractFile, TFolder } from "obsidian";
import MetadataStore, { MANIFEST_FILE_NAME } from "./metadata-store";
import { GitHubSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import GitHubSyncPlugin from "./main";
import { isTrackableSyncFolderPath, isTrackableSyncPath } from "./sync-scope";

type PathLike = TAbstractFile | { path: string } | string;

/**
 * Tracks changes to local sync directory and updates files metadata.
 *
 * Supports pause/resume for sync operations: when paused, events are
 * silently ignored. After sync completes, files written by sync are
 * tracked in syncWrittenPaths so we can distinguish sync writes from
 * user edits that happened during the pause window.
 */
export default class EventsListener {
  private paused: boolean = false;

  /**
   * Files written by the sync engine during the current sync cycle.
   * Maps file path → expected SHA after sync write.
   * Used during resume to detect user edits that happened during sync.
   */
  syncWrittenPaths: Map<string, string | null> = new Map();

  constructor(
    private vault: Vault,
    private metadataStore: MetadataStore,
    private settings: GitHubSyncSettings,
    private logger: Logger,
  ) {}

  start(plugin: GitHubSyncPlugin) {
    // We need to register all the events we subscribe to so they can
    // be correctly detached when the plugin is unloaded too.
    // If we don't they might be left hanging and cause issues.
    plugin.registerEvent(this.vault.on("create", this.onCreate.bind(this)));
    plugin.registerEvent(this.vault.on("delete", this.onDelete.bind(this)));
    plugin.registerEvent(this.vault.on("modify", this.onModify.bind(this)));
    plugin.registerEvent(this.vault.on("rename", this.onRename.bind(this)));
  }

  /**
   * Pause event processing during sync operations.
   * Events that fire while paused are silently ignored.
   */
  pause() {
    this.paused = true;
    this.syncWrittenPaths.clear();
  }

  /**
   * Resume event processing after sync completes.
   * Clears the sync-written paths tracker.
   */
  resume() {
    this.paused = false;
    this.syncWrittenPaths.clear();
  }

  isPaused(): boolean {
    return this.paused;
  }

  private shouldTrackDeletedFolder(folderPath: string): boolean {
    const leaf = folderPath.split("/").pop() ?? folderPath;
    return (
      isTrackableSyncFolderPath(folderPath, {
        configDir: this.vault.configDir,
        syncConfigDir: this.settings.syncConfigDir,
      }) &&
      !/\.(md|txt|csv|json|png|jpg|jpeg|webp|gif|svg|pdf|mp3|m4a|wav|webm|mp4)$/i.test(
        leaf,
      )
    );
  }

  private async upsertFolder(path: string) {
    this.metadataStore.data.folders ??= {};
    const current = this.metadataStore.data.folders[path];
    this.metadataStore.data.folders[path] = {
      ...current,
      path,
      deleted: false,
      deletedAt: null,
      lastModified: Date.now(),
    };
    await this.metadataStore.save();
  }

  private async markFolderDeleted(path: string) {
    this.metadataStore.data.folders ??= {};
    const current = this.metadataStore.data.folders[path];
    const deletedAt = current?.deletedAt ?? Date.now();
    this.metadataStore.data.folders[path] = {
      ...current,
      path,
      deleted: true,
      deletedAt,
      lastModified: Date.now(),
    };
  }

  private rewriteFolderDescendants(oldPath: string, newPath: string) {
    this.metadataStore.data.folders ??= {};
    const nextFolders = { ...this.metadataStore.data.folders };

    for (const [path, meta] of Object.entries(this.metadataStore.data.folders)) {
      if (!path.startsWith(`${oldPath}/`)) {
        continue;
      }
      delete nextFolders[path];
      const rewrittenPath = `${newPath}${path.slice(oldPath.length)}`;
      nextFolders[rewrittenPath] = {
        ...meta,
        path: rewrittenPath,
        deleted: false,
        deletedAt: null,
        lastModified: Date.now(),
      };
    }

    this.metadataStore.data.folders = nextFolders;
  }

  private isFolderLike(value: unknown): value is { path: string } {
    return (
      !!value &&
      typeof value === "object" &&
      typeof (value as any).path === "string" &&
      (Array.isArray((value as any).children) ||
        typeof (value as any).isRoot === "function")
    );
  }

  private shouldTreatAsFolderCandidate(file: PathLike): boolean {
    const filePath = typeof file === "string" ? file : file.path;
    if (!this.shouldTrackDeletedFolder(filePath) || this.isSyncable(filePath)) {
      return false;
    }
    if (typeof file === "string") {
      return true;
    }
    return !("stat" in file) && !("extension" in file);
  }

  private async resolvePathKind(file: PathLike): Promise<"folder" | "file"> {
    const filePath = typeof file === "string" ? file : file.path;
    const shouldPreferFolderChecks =
      this.shouldTrackDeletedFolder(filePath) && !this.isSyncable(filePath);
    if (file instanceof TFolder || this.isFolderLike(file)) {
      return "folder";
    }
    if (this.metadataStore.data.folders?.[filePath]) {
      return "folder";
    }

    const abstractFile = (this.vault as any).getAbstractFileByPath?.(filePath);
    if (abstractFile instanceof TFolder || this.isFolderLike(abstractFile)) {
      return "folder";
    }
    if (abstractFile && !shouldPreferFolderChecks) {
      return "file";
    }

    const loadedFiles = (this.vault as any).getAllLoadedFiles?.();
    if (Array.isArray(loadedFiles)) {
      const loadedFolder = loadedFiles.find(
        (entry: unknown) =>
          this.isFolderLike(entry) && (entry as { path: string }).path === filePath,
      );
      if (loadedFolder) {
        return "folder";
      }
    }

    const adapter = this.vault.adapter as any;
    if (typeof adapter.stat === "function") {
      try {
        const stat = await adapter.stat(filePath);
        if (stat) {
          const statType =
            typeof stat.type === "string" ? stat.type.toLowerCase() : null;
          if (statType === "folder" || statType === "directory") {
            return "folder";
          }
          if (statType === "file") {
            return "file";
          }
          if (typeof stat.isDirectory === "boolean") {
            return stat.isDirectory ? "folder" : "file";
          }
          if (typeof stat.isFile === "boolean") {
            return stat.isFile ? "file" : "folder";
          }
        }
      } catch {
        // Path may already be gone; fall through to file default.
      }
    }

    return "file";
  }

  private async onCreate(file: TAbstractFile) {
    if (this.paused) return;
    await this.logger.info("Received create event", file.path);
    const resolvedKind = await this.resolvePathKind(file);
    const folderCandidate = this.shouldTreatAsFolderCandidate(file);
    if (resolvedKind === "folder" || folderCandidate) {
      if (!this.shouldTrackDeletedFolder(file.path)) {
        await this.logger.info("Skipped created folder", file.path);
        return;
      }
      await this.upsertFolder(file.path);
      await this.logger.info("Updated created folder", file.path);
      return;
    }
    if (!this.isSyncable(file.path)) {
      // The file has not been created in directory that we're syncing with GitHub
      await this.logger.info("Skipped created file", file.path);
      return;
    }

    const data = this.metadataStore.data.files[file.path];
    if (data && data.justDownloaded) {
      // This file was just downloaded and not created by the user.
      // It's enough to mark it as non just downloaded.
      this.metadataStore.data.files[file.path].justDownloaded = false;
      await this.metadataStore.save();
      await this.logger.info("Updated just downloaded created file", file.path);
      return;
    }

    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: null,
      dirty: true,
      // This file has been created by the user
      justDownloaded: false,
      lastModified: Date.now(),
    };
    await this.metadataStore.save();
    await this.logger.info("Updated created file", file.path);
  }

  private async onDelete(file: TAbstractFile | string) {
    if (this.paused) return;
    const filePath = file instanceof TAbstractFile ? file.path : file;
    await this.logger.info("Received delete event", filePath);
    if (
      (await this.resolvePathKind(file)) === "folder" ||
      this.shouldTreatAsFolderCandidate(file)
    ) {
      if (!this.shouldTrackDeletedFolder(filePath)) {
        await this.logger.warn("Skipped invalid deleted folder event", filePath);
        return;
      }
      await this.markFolderDeleted(filePath);
      if (!this.metadataStore.data.deletedFolders) {
        this.metadataStore.data.deletedFolders = [];
      }
      if (!this.metadataStore.data.deletedFolders.contains(filePath)) {
        this.metadataStore.data.deletedFolders.push(filePath);
      }
      await this.metadataStore.save();
      await this.logger.info("Tracked explicit deleted folder", filePath);
      return;
    }
    if (!this.isSyncable(filePath)) {
      // The file was not in directory that we're syncing with GitHub
      return;
    }

    if (!this.metadataStore.data.files[filePath]) {
      // The file is not tracked in metadata, nothing to update.
      return;
    }
    this.metadataStore.data.files[filePath].deleted = true;
    this.metadataStore.data.files[filePath].deletedAt = Date.now();
    await this.metadataStore.save();
    await this.logger.info("Updated deleted file", filePath);
  }

  private async onModify(file: TAbstractFile) {
    if (this.paused) return;
    await this.logger.info("Received modify event", file.path);
    if (file instanceof TFolder) {
      return;
    }
    if (!this.isSyncable(file.path)) {
      // The file has not been create in directory that we're syncing with GitHub
      await this.logger.info("Skipped modified file", file.path);
      return;
    }
    const data = this.metadataStore.data.files[file.path];
    if (data && data.justDownloaded) {
      // This file was just downloaded and not modified by the user.
      // It's enough to makr it as non just downloaded.
      this.metadataStore.data.files[file.path].justDownloaded = false;
      await this.metadataStore.save();
      await this.logger.info(
        "Updated just downloaded modified file",
        file.path,
      );
      return;
    }
    if (!this.metadataStore.data.files[file.path]) {
      this.metadataStore.data.files[file.path] = {
        path: file.path,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: 0,
      };
    }
    this.metadataStore.data.files[file.path].lastModified = Date.now();
    this.metadataStore.data.files[file.path].dirty = true;
    await this.metadataStore.save();
    await this.logger.info("Updated modified file", file.path);
  }

  private async onRename(file: TAbstractFile, oldPath: string) {
    if (this.paused) return;
    await this.logger.info("Received rename event", file.path);
    if (
      (await this.resolvePathKind(file)) === "folder" ||
      this.shouldTreatAsFolderCandidate(file) ||
      this.shouldTreatAsFolderCandidate(oldPath)
    ) {
      const oldSyncable = this.shouldTrackDeletedFolder(oldPath);
      const newSyncable = this.shouldTrackDeletedFolder(file.path);

      if (!oldSyncable && !newSyncable) {
        return;
      }

      if (oldSyncable) {
        await this.markFolderDeleted(oldPath);
      }
      if (newSyncable) {
        this.rewriteFolderDescendants(oldPath, file.path);
        await this.upsertFolder(file.path);
      } else {
        await this.metadataStore.save();
      }
      return;
    }
    if (!this.isSyncable(file.path) && !this.isSyncable(oldPath)) {
      // Both are not in directory that we're syncing with GitHub
      return;
    }

    if (this.isSyncable(file.path) && this.isSyncable(oldPath)) {
      // Both files are in the synced directory
      // First create the new one
      await this.onCreate(file);
      // Then delete the old one
      await this.onDelete(oldPath);
      return;
    } else if (this.isSyncable(file.path)) {
      // Only the new file is in the local directory
      await this.onCreate(file);
      return;
    } else if (this.isSyncable(oldPath)) {
      // Only the old file was in the local directory
      await this.onDelete(oldPath);
      return;
    }
  }

  private isSyncable(filePath: string) {
    return isTrackableSyncPath(filePath, {
      configDir: this.vault.configDir,
      manifestPath: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
      logPath: `${this.vault.configDir}/${LOG_FILE_NAME}`,
      syncConfigDir: this.settings.syncConfigDir,
      syncScopeMode: this.settings.syncScopeMode,
      includeManifest: true,
    });
  }
}
