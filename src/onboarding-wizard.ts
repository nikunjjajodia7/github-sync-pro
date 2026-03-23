import { Modal, Setting, Notice } from "obsidian";
import GitHubSyncPlugin from "./main";
import {
  requestDeviceCode,
  pollForToken,
  validateToken,
  listUserRepos,
  createRepo,
  GitHubUser,
  GitHubRepo,
} from "./oauth";
import { copyToClipboard } from "./utils";

type WizardStep = "sign-in" | "polling" | "select-repo" | "create-repo" | "done";

export class OnboardingWizardModal extends Modal {
  private plugin: GitHubSyncPlugin;
  private step: WizardStep = "sign-in";

  // OAuth state
  private userCode: string = "";
  private verificationUri: string = "";
  private deviceCode: string = "";
  private pollInterval: number = 5;
  private token: string = "";
  private refreshToken: string = "";

  // User state
  private user: GitHubUser | null = null;
  private repos: GitHubRepo[] = [];
  private selectedRepo: string = "";
  private newRepoName: string = "obsidian-vault";
  private abortPolling: boolean = false;
  private _tokenExpiresIn: number = 0;

  constructor(plugin: GitHubSyncPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.renderStep();
  }

  onClose() {
    this.abortPolling = true;
  }

  private renderStep() {
    const { contentEl } = this;
    contentEl.empty();

    switch (this.step) {
      case "sign-in":
        this.renderSignIn();
        break;
      case "polling":
        this.renderPolling();
        break;
      case "select-repo":
        this.renderSelectRepo();
        break;
      case "create-repo":
        this.renderCreateRepo();
        break;
      case "done":
        this.renderDone();
        break;
    }
  }

  private renderSignIn() {
    this.setTitle("GitHub Sync Pro Setup");
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: "Sign in with GitHub to sync your vault. This will open a browser window where you authorize the plugin to access your repositories.",
    });

    contentEl.createEl("p", {
      text: "Your notes are synced to your own GitHub repo — GitHub Sync Pro never sees or stores your data.",
      cls: "setting-item-description",
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Sign in with GitHub")
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Connecting...");
          try {
            const response = await requestDeviceCode();
            this.userCode = response.user_code;
            this.verificationUri = response.verification_uri;
            this.deviceCode = response.device_code;
            this.pollInterval = response.interval;

            this.step = "polling";
            this.renderStep();
            this.startPolling();
          } catch (err) {
            new Notice(`Failed to connect: ${err.message}`);
            btn.setDisabled(false);
            btn.setButtonText("Sign in with GitHub");
          }
        }),
    );

    // Manual token option for advanced users
    contentEl.createEl("div", { cls: "setting-item-description" }).createEl("small", {
      text: "Advanced: You can also configure a personal access token manually in the settings below.",
    });
  }

  private renderPolling() {
    this.setTitle("Enter Code on GitHub");
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: "Go to the link below and enter this code:",
    });

    // Large code display
    const codeContainer = contentEl.createEl("div", {
      attr: { style: "text-align: center; margin: 16px 0;" },
    });
    codeContainer.createEl("div", {
      text: this.userCode,
      attr: {
        style:
          "font-size: 28px; font-weight: bold; letter-spacing: 4px; font-family: monospace; padding: 12px; background: var(--background-modifier-form-field); border-radius: 8px; display: inline-block; user-select: all;",
      },
    });

    new Setting(contentEl)
      .setName(this.verificationUri)
      .addButton((btn) =>
        btn.setButtonText("Copy code").onClick(async () => {
          await copyToClipboard(this.userCode);
          new Notice("Code copied!");
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Open GitHub")
          .setCta()
          .onClick(() => {
            // Only open URLs from github.com to prevent open-redirect attacks
            if (this.verificationUri.startsWith("https://github.com/")) {
              window.open(this.verificationUri);
            } else {
              new Notice("Unexpected verification URL. Please visit github.com/login/device manually.");
            }
          }),
      );

    const statusEl = contentEl.createEl("p", {
      text: "Waiting for authorization...",
      cls: "setting-item-description",
      attr: { style: "text-align: center;" },
    });

    // Spinner
    statusEl.createEl("span", {
      attr: { style: "display: inline-block; animation: spin 1s linear infinite; margin-left: 8px;" },
      text: "⏳",
    });

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => {
        this.abortPolling = true;
        this.close();
      }),
    );
  }

  private async startPolling() {
    try {
      const tokenResponse = await pollForToken(this.deviceCode, this.pollInterval);
      if (this.abortPolling) return;

      this.token = tokenResponse.access_token;
      this.refreshToken = tokenResponse.refresh_token || "";
      this._tokenExpiresIn = tokenResponse.expires_in || 0;

      // Validate and get user info
      this.user = await validateToken(this.token);
      if (this.abortPolling) return;

      // List repos
      this.repos = await listUserRepos(this.token);
      if (this.abortPolling) return;

      this.step = "select-repo";
      this.renderStep();
    } catch (err) {
      if (this.abortPolling) return;
      new Notice(`Authorization failed: ${err.message}`);
      this.step = "sign-in";
      this.renderStep();
    }
  }

  private renderSelectRepo() {
    this.setTitle(`Welcome, ${this.user?.name || this.user?.login}!`);
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: "Choose a repository to sync this vault with, or create a new one.",
    });

    // Repo dropdown
    const repoOptions: Record<string, string> = { "": "-- Select a repository --" };
    for (const repo of this.repos) {
      repoOptions[repo.name] = `${repo.name}${repo.private ? " 🔒" : ""}`;
    }

    new Setting(contentEl)
      .setName("Repository")
      .setDesc("Select an existing repository")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(repoOptions)
          .setValue(this.selectedRepo)
          .onChange((value) => {
            this.selectedRepo = value;
          }),
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Use selected repo")
          .setCta()
          .onClick(async () => {
            if (!this.selectedRepo) {
              new Notice("Please select a repository");
              return;
            }
            await this.finishSetup(this.selectedRepo);
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Create new repo").onClick(() => {
          this.step = "create-repo";
          this.renderStep();
        }),
      );
  }

  private renderCreateRepo() {
    this.setTitle("Create New Repository");
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: "A new private repository will be created in your GitHub account to store your vault.",
    });

    new Setting(contentEl)
      .setName("Repository name")
      .addText((text) =>
        text
          .setPlaceholder("obsidian-vault")
          .setValue(this.newRepoName)
          .onChange((value) => {
            this.newRepoName = value;
          }),
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Create & sync")
          .setCta()
          .onClick(async () => {
            if (!this.newRepoName.trim()) {
              new Notice("Please enter a repository name");
              return;
            }
            btn.setDisabled(true);
            btn.setButtonText("Creating...");
            try {
              await createRepo(this.token, this.newRepoName.trim());
              await this.finishSetup(this.newRepoName.trim());
            } catch (err) {
              new Notice(`Failed: ${err.message}`);
              btn.setDisabled(false);
              btn.setButtonText("Create & sync");
            }
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Back").onClick(() => {
          this.step = "select-repo";
          this.renderStep();
        }),
      );
  }

  private async finishSetup(repoName: string) {
    // Save all settings
    this.plugin.settings.githubToken = this.token;
    this.plugin.settings.githubOwner = this.user!.login;
    this.plugin.settings.githubRepo = repoName;
    this.plugin.settings.githubBranch = "main";
    this.plugin.settings.refreshToken = this.refreshToken;
    // Use actual expires_in from token response if available, fall back to 8 hours
    this.plugin.settings.tokenExpiresAt = this.refreshToken
      ? Date.now() + (this._tokenExpiresIn || 8 * 60 * 60) * 1000
      : 0; // 0 means no expiry
    this.plugin.settings.firstSync = true;
    this.plugin.settings.syncStrategy = "interval";
    this.plugin.settings.syncInterval = 5;
    this.plugin.settings.syncOnStartup = true;
    await this.plugin.saveSettings();

    this.step = "done";
    this.renderStep();
  }

  private renderDone() {
    this.setTitle("You're all set!");
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: `Your vault will sync to github.com/${this.user!.login}/${this.plugin.settings.githubRepo}.`,
    });

    contentEl.createEl("p", {
      text: "Sync will start automatically. You can change settings anytime in the plugin settings tab.",
      cls: "setting-item-description",
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Start syncing")
        .setCta()
        .onClick(async () => {
          this.close();
          // Trigger first sync
          this.plugin.restartSyncInterval();
          await this.plugin.sync();
        }),
    );
  }
}
