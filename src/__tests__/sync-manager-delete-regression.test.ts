import { beforeEach, describe, expect, it, vi } from "vitest";
import SyncManager from "../sync-manager";
import {
  createMockLogger,
  createMockMetadataStore,
  createMockVault,
  makeFileMetadata,
} from "./helpers";

describe("SyncManager delete regression hardening", () => {
  let vault: ReturnType<typeof createMockVault>;
  let syncManager: SyncManager;
  let metadataStore: ReturnType<typeof createMockMetadataStore>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
      }),
    });
    logger = createMockLogger();
    metadataStore = createMockMetadataStore();
    syncManager = new SyncManager(
      vault as any,
      {
        firstSync: false,
        githubToken: "test",
        githubOwner: "owner",
        githubRepo: "repo",
        githubBranch: "main",
        syncScopeMode: "notes-first",
        syncStrategy: "manual",
        syncInterval: 5,
        syncOnStartup: false,
        syncConfigDir: false,
        conflictHandling: "ask",
        conflictViewMode: "default",
        showStatusBarItem: true,
        showSyncRibbonButton: true,
        showConflictsRibbonButton: true,
        enableLogging: false,
      },
      async () => [],
      logger as any,
    );
    (syncManager as any).metadataStore = metadataStore;
  });

  it("reconciles missing tracked files into deleted tombstones", async () => {
    metadataStore.data.files["ghost.md"] = makeFileMetadata("ghost.md", {
      dirty: true,
      justDownloaded: true,
    });

    const count = await (syncManager as any).reconcileMissingLocalMetadataEntries();

    expect(count).toBe(1);
    expect(metadataStore.data.files["ghost.md"]).toMatchObject({
      deleted: true,
      dirty: false,
      justDownloaded: false,
    });
    expect(metadataStore.save).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Reconciled missing local metadata entries",
      expect.objectContaining({ count: 1 }),
    );
  });

  it("stops planning delete_local when remote already deleted and file is missing on disk", async () => {
    metadataStore.data.files["Test Test 123/Hello hello test.md"] =
      makeFileMetadata("Test Test 123/Hello hello test.md", {
        sha: "same_sha",
      });

    await (syncManager as any).reconcileMissingLocalMetadataEntries();

    const actions = await syncManager.determineSyncActions(
      {
        "Test Test 123/Hello hello test.md": makeFileMetadata(
          "Test Test 123/Hello hello test.md",
          {
            sha: "same_sha",
            deleted: true,
          },
        ),
      },
      metadataStore.data.files,
      [],
    );

    expect(actions).toHaveLength(0);
  });

  it("keeps delete propagation semantics for missing local files when remote is unchanged", async () => {
    metadataStore.data.files["ghost.md"] = makeFileMetadata("ghost.md", {
      sha: "same_sha",
    });

    await (syncManager as any).reconcileMissingLocalMetadataEntries();

    const actions = await syncManager.determineSyncActions(
      {
        "ghost.md": makeFileMetadata("ghost.md", {
          sha: "same_sha",
        }),
      },
      metadataStore.data.files,
      [],
    );

    expect(actions).toContainEqual({
      type: "delete_remote",
      filePath: "ghost.md",
    });
  });

  it("treats already-missing files as successful local deletes", async () => {
    metadataStore.data.files["ghost.md"] = makeFileMetadata("ghost.md");

    await expect(syncManager.deleteLocalFile("ghost.md")).resolves.toBeUndefined();

    expect(metadataStore.data.files["ghost.md"]).toMatchObject({
      deleted: true,
      dirty: false,
      justDownloaded: false,
    });
    expect(vault.adapter.remove).not.toHaveBeenCalled();
    expect(metadataStore.save).toHaveBeenCalledTimes(1);
  });

  it("does not prune empty parent folders for ordinary file tombstones", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
      }),
      "Projects/ghost.md": "content",
    });
    logger = createMockLogger();
    metadataStore = createMockMetadataStore({
      "Projects/ghost.md": makeFileMetadata("Projects/ghost.md"),
    });
    syncManager = new SyncManager(
      vault as any,
      {
        firstSync: false,
        githubToken: "test",
        githubOwner: "owner",
        githubRepo: "repo",
        githubBranch: "main",
        syncScopeMode: "notes-first",
        syncStrategy: "manual",
        syncInterval: 5,
        syncOnStartup: false,
        syncConfigDir: false,
        conflictHandling: "ask",
        conflictViewMode: "default",
        showStatusBarItem: true,
        showSyncRibbonButton: true,
        showConflictsRibbonButton: true,
        enableLogging: false,
      },
      async () => [],
      logger as any,
    );
    (syncManager as any).metadataStore = metadataStore;

    await expect(syncManager.deleteLocalFile("Projects/ghost.md")).resolves.toBeUndefined();

    expect(await vault.adapter.exists("Projects")).toBe(true);
    expect(vault.adapter.rmdir).not.toHaveBeenCalled();
  });

  it("swallows ENOENT from remove and still tombstones metadata", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
      }),
      "ghost.md": "content",
    });
    logger = createMockLogger();
    metadataStore = createMockMetadataStore({
      "ghost.md": makeFileMetadata("ghost.md"),
    });
    syncManager = new SyncManager(
      vault as any,
      {
        firstSync: false,
        githubToken: "test",
        githubOwner: "owner",
        githubRepo: "repo",
        githubBranch: "main",
        syncScopeMode: "notes-first",
        syncStrategy: "manual",
        syncInterval: 5,
        syncOnStartup: false,
        syncConfigDir: false,
        conflictHandling: "ask",
        conflictViewMode: "default",
        showStatusBarItem: true,
        showSyncRibbonButton: true,
        showConflictsRibbonButton: true,
        enableLogging: false,
      },
      async () => [],
      logger as any,
    );
    (syncManager as any).metadataStore = metadataStore;
    vault.adapter.remove.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      }),
    );

    await expect(syncManager.deleteLocalFile("ghost.md")).resolves.toBeUndefined();

    expect(metadataStore.data.files["ghost.md"]).toMatchObject({
      deleted: true,
      dirty: false,
      justDownloaded: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Local file disappeared during delete_local, treating as already deleted",
      "ghost.md",
    );
  });
});
