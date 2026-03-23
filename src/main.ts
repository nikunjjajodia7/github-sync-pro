import {
  EventRef,
  Plugin,
  WorkspaceLeaf,
  normalizePath,
  Notice,
} from "obsidian";
import { GitHubSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import GitHubSyncSettingsTab from "./settings/tab";
import SyncManager, { ConflictFile, ConflictResolution } from "./sync-manager";
import Logger from "./logger";
import {
  ConflictsResolutionView,
  CONFLICTS_RESOLUTION_VIEW_TYPE,
} from "./views/conflicts-resolution/view";
import {
  VersionHistoryItemView,
  VERSION_HISTORY_VIEW_TYPE,
} from "./views/version-history/view";
import { OnboardingWizardModal } from "./onboarding-wizard";
import { refreshAccessToken, validateToken } from "./oauth";

export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  syncManager: SyncManager;
  logger: Logger;

  // Cache token validation to avoid burning rate limit on every push-on-save
  private lastTokenValidation: number = 0;
  private static readonly TOKEN_VALIDATION_CACHE_MS = 5 * 60 * 1000; // 5 minutes

  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  conflictsRibbonIcon: HTMLElement | null = null;

  activeLeafChangeListener: EventRef | null = null;
  vaultCreateListener: EventRef | null = null;
  vaultModifyListener: EventRef | null = null;

  // Called in ConflictResolutionView when the user solves all the conflicts.
  // This is initialized every time we open the view to set new conflicts so
  // we can notify the SyncManager that everything has been resolved and the sync
  // process can continue on.
  conflictsResolver: ((resolutions: ConflictResolution[]) => void) | null =
    null;

  // We keep track of the sync conflicts in here too in case the
  // conflicts view must be rebuilt, or the user closes the view
  // and it gets destroyed.
  // By keeping them here we can recreate it easily.
  private conflicts: ConflictFile[] = [];

  private isConfigured(): boolean {
    return (
      this.settings.githubToken !== "" &&
      this.settings.githubOwner !== "" &&
      this.settings.githubRepo !== "" &&
      this.settings.githubBranch !== ""
    );
  }

  async onUserEnable() {
    if (!this.isConfigured()) {
      // Show onboarding wizard for new users
      new OnboardingWizardModal(this).open();
    }
  }

  /**
   * Check if the token needs refreshing and refresh it if needed.
   * Called on startup before any sync operations.
   */
  private async ensureValidToken(): Promise<boolean> {
    if (!this.settings.githubToken) return false;

    // If we have a refresh token and the access token is expired or expiring soon
    if (this.settings.refreshToken && this.settings.tokenExpiresAt > 0) {
      const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
      if (this.settings.tokenExpiresAt < fiveMinutesFromNow) {
        try {
          this.logger.info("Access token expired or expiring soon, refreshing...");
          const newToken = await refreshAccessToken(this.settings.refreshToken);
          this.settings.githubToken = newToken.access_token;
          this.settings.refreshToken = newToken.refresh_token || this.settings.refreshToken;
          this.settings.tokenExpiresAt = newToken.expires_in
            ? Date.now() + newToken.expires_in * 1000
            : 0;
          await this.saveSettings();
          this.logger.info("Token refreshed successfully");
          return true;
        } catch (err) {
          this.logger.error("Failed to refresh token", err);
          new Notice("GitHub token expired. Please re-authenticate in settings.");
          return false;
        }
      }
    }

    // Validate the token is still good (lightweight check, cached for 5 min)
    if (Date.now() - this.lastTokenValidation < GitHubSyncPlugin.TOKEN_VALIDATION_CACHE_MS) {
      return true; // recently validated
    }
    try {
      await validateToken(this.settings.githubToken);
      this.lastTokenValidation = Date.now();
      return true;
    } catch {
      this.lastTokenValidation = 0;
      new Notice("GitHub token is invalid. Please re-authenticate in settings.");
      return false;
    }
  }

  getConflictsView(): ConflictsResolutionView | null {
    const leaves = this.app.workspace.getLeavesOfType(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
    );
    if (leaves.length === 0) {
      return null;
    }
    return leaves[0].view as ConflictsResolutionView;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CONFLICTS_RESOLUTION_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf(false)!;
      await leaf.setViewState({
        type: CONFLICTS_RESOLUTION_VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.enableLogging);
    this.logger.init();

    this.registerView(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
      (leaf) => new ConflictsResolutionView(leaf, this, this.conflicts),
    );

    this.registerView(
      VERSION_HISTORY_VIEW_TYPE,
      (leaf) => new VersionHistoryItemView(leaf, this, ""),
    );

    this.addSettingTab(new GitHubSyncSettingsTab(this.app, this));

    this.syncManager = new SyncManager(
      this.app.vault,
      this.settings,
      this.onConflicts.bind(this),
      this.logger,
    );
    await this.syncManager.loadMetadata();

    if (this.settings.syncStrategy == "interval") {
      this.restartSyncInterval();
    }

    this.app.workspace.onLayoutReady(async () => {
      if (!this.conflictsResolver && this.conflicts.length === 0) {
        // Close stale conflict views restored from workspace state.
        this.app.workspace
          .getLeavesOfType(CONFLICTS_RESOLUTION_VIEW_TYPE)
          .forEach((leaf) => leaf.detach());
      }

      // Create the events handling only after tha layout is ready to avoid
      // getting spammed with create events.
      // See the official Obsidian docs:
      // https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('create')
      this.syncManager.startEventsListener(this);

      // Load the ribbons after layout is ready so they're shown after the core
      // buttons
      if (this.settings.showStatusBarItem) {
        this.showStatusBarItem();
      }

      if (this.settings.showConflictsRibbonButton) {
        this.showConflictsRibbonIcon();
      }

      if (this.settings.showSyncRibbonButton) {
        this.showSyncRibbonIcon();
      }

      if (this.settings.syncOnStartup) {
        await this.sync();
      }
    });

    this.addCommand({
      id: "sync-files",
      name: "Sync with GitHub",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.sync.bind(this),
    });

    this.addCommand({
      id: "merge",
      name: "Open sync conflicts view",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.openConflictsView.bind(this),
    });

    this.addCommand({
      id: "setup-wizard",
      name: "Setup wizard",
      repeatable: false,
      icon: "settings",
      callback: () => new OnboardingWizardModal(this).open(),
    });

    this.addCommand({
      id: "view-file-history",
      name: "View file history",
      repeatable: false,
      icon: "history",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !this.isConfigured()) return false;
        if (checking) return true;
        this.openVersionHistory(activeFile.path);
      },
    });

    // Register file menu item for right-click → "View history"
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!this.isConfigured()) return;
        if (file instanceof this.app.vault.constructor) return; // skip folders
        menu.addItem((item) => {
          item
            .setTitle("View sync history")
            .setIcon("history")
            .onClick(() => this.openVersionHistory(file.path));
        });
      }),
    );
  }

  async openVersionHistory(filePath: string) {
    const { workspace } = this.app;
    // Check if view already open
    const existing = workspace.getLeavesOfType(VERSION_HISTORY_VIEW_TYPE);
    if (existing.length > 0) {
      const view = existing[0].view as VersionHistoryItemView;
      view.setFilePath(filePath);
      workspace.revealLeaf(existing[0]);
      return;
    }
    // Open in a new leaf to the right
    const leaf = workspace.getLeaf("split", "vertical");
    await leaf.setViewState({
      type: VERSION_HISTORY_VIEW_TYPE,
      active: true,
    });
    const view = leaf.view as VersionHistoryItemView;
    view.setFilePath(filePath);
    workspace.revealLeaf(leaf);
  }

  async sync() {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured. Use the setup wizard to get started.");
      return;
    }

    // Ensure token is valid before syncing (refresh if needed)
    const tokenValid = await this.ensureValidToken();
    if (!tokenValid) return;
    if (this.settings.firstSync) {
      const notice = new Notice("Syncing...");
      try {
        await this.syncManager.firstSync();
        this.settings.firstSync = false;
        this.saveSettings();
        // Shown only if sync doesn't fail
        new Notice("Sync successful", 5000);
      } catch (err) {
        // Show the error to the user, it's not automatically dismissed to make sure
        // the user sees it.
        new Notice(`Error syncing. ${err}`);
      }
      notice.hide();
    } else {
      await this.syncManager.sync();
    }
    this.updateStatusBarItem();
  }

  async onunload() {
    this.stopSyncInterval();
  }

  showStatusBarItem() {
    if (this.statusBarItem) {
      return;
    }
    this.statusBarItem = this.addStatusBarItem();

    if (!this.activeLeafChangeListener) {
      this.activeLeafChangeListener = this.app.workspace.on(
        "active-leaf-change",
        () => this.updateStatusBarItem(),
      );
    }
    if (!this.vaultCreateListener) {
      this.vaultCreateListener = this.app.vault.on("create", () => {
        this.updateStatusBarItem();
      });
    }
    if (!this.vaultModifyListener) {
      this.vaultModifyListener = this.app.vault.on("modify", () => {
        this.updateStatusBarItem();
      });
    }
  }

  hideStatusBarItem() {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  updateStatusBarItem() {
    if (!this.statusBarItem) {
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return;
    }

    let state = "Unknown";
    const fileData = this.syncManager.getFileMetadata(activeFile.path);
    if (!fileData) {
      state = "Untracked";
    } else if (fileData.dirty) {
      state = "Outdated";
    } else if (!fileData.dirty) {
      state = "Up to date";
    }

    this.statusBarItem.setText(`GitHub: ${state}`);
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitHub",
      this.sync.bind(this),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  showConflictsRibbonIcon() {
    if (this.conflictsRibbonIcon) {
      return;
    }
    this.conflictsRibbonIcon = this.addRibbonIcon(
      "merge",
      "Open sync conflicts view",
      this.openConflictsView.bind(this),
    );
  }

  hideConflictsRibbonIcon() {
    this.conflictsRibbonIcon?.remove();
    this.conflictsRibbonIcon = null;
  }

  async openConflictsView() {
    await this.activateView();
    this.getConflictsView()?.setConflictFiles(this.conflicts);
  }

  async onConflicts(conflicts: ConflictFile[]): Promise<ConflictResolution[]> {
    this.conflicts = conflicts;
    return await new Promise(async (resolve) => {
      this.conflictsResolver = (resolutions: ConflictResolution[]) => {
        // Clear cached conflicts once resolved so manual-opened view
        // doesn't keep showing stale entries.
        this.conflicts = [];
        resolve(resolutions);
      };
      await this.activateView();
      this.getConflictsView()?.setConflictFiles(conflicts);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Proxy methods from sync manager to ease handling the interval
  // when settings are changed
  startSyncInterval() {
    const intervalID = this.syncManager.startSyncInterval(
      this.settings.syncInterval,
    );
    this.registerInterval(intervalID);
  }

  stopSyncInterval() {
    this.syncManager.stopSyncInterval();
  }

  restartSyncInterval() {
    this.syncManager.stopSyncInterval();
    this.syncManager.startSyncInterval(this.settings.syncInterval);
  }

  async reset() {
    this.settings = DEFAULT_SETTINGS;
    this.saveSettings();
    await this.syncManager.resetMetadata();
  }
}
