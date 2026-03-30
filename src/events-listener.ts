import { Vault, TAbstractFile, TFolder } from "obsidian";
import MetadataStore, { MANIFEST_FILE_NAME } from "./metadata-store";
import { GitHubSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import GitHubSyncPlugin from "./main";
import { isTrackableSyncFolderPath, isTrackableSyncPath } from "./sync-scope";

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

  private async onCreate(file: TAbstractFile) {
    if (this.paused) return;
    await this.logger.info("Received create event", file.path);
    if (!this.isSyncable(file.path)) {
      // The file has not been created in directory that we're syncing with GitHub
      await this.logger.info("Skipped created file", file.path);
      return;
    }
    if (file instanceof TFolder) {
      // Skip folders
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
    if (file instanceof TFolder) {
      if (!this.shouldTrackDeletedFolder(filePath)) {
        await this.logger.warn("Skipped invalid deleted folder event", filePath);
        return;
      }
      if (!this.metadataStore.data.deletedFolders) {
        this.metadataStore.data.deletedFolders = [];
      }
      if (!this.metadataStore.data.deletedFolders.contains(filePath)) {
        this.metadataStore.data.deletedFolders.push(filePath);
        await this.metadataStore.save();
        await this.logger.info("Tracked explicit deleted folder", filePath);
      }
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
    if (!this.isSyncable(file.path)) {
      // The file has not been create in directory that we're syncing with GitHub
      await this.logger.info("Skipped modified file", file.path);
      return;
    }
    if (file instanceof TFolder) {
      // Skip folders
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
    if (file instanceof TFolder) {
      // Skip folders
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
