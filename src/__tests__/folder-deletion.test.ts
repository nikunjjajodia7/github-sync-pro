import { beforeEach, describe, expect, it } from "vitest";
import { TFolder } from "obsidian";
import SyncManager from "../sync-manager";
import EventsListener from "../events-listener";
import {
  createMockGithubClient,
  createMockLogger,
  createMockMetadataStore,
  createMockVault,
  makeTreeFile,
} from "./helpers";

describe("folder deletion propagation", () => {
  let vault: ReturnType<typeof createMockVault>;
  let settings: any;

  beforeEach(() => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({ lastSync: 0, files: {} }),
    });
    settings = {
      firstSync: false,
      githubToken: "test",
      githubOwner: "owner",
      githubRepo: "repo",
      githubBranch: "main",
      syncScopeMode: "notes-first" as const,
      syncStrategy: "manual" as const,
      syncInterval: 5,
      syncOnStartup: false,
      syncConfigDir: false,
      conflictHandling: "ask" as const,
      conflictViewMode: "default" as const,
      showStatusBarItem: true,
      showSyncRibbonButton: true,
      showConflictsRibbonButton: true,
      enableLogging: false,
    };
  });

  it("sanitizes file-like deletedFolders entries from metadata load", async () => {
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore();
    (syncManager as any).metadataStore = metadataStore;

    metadataStore.data.deletedFolders = [
      "Projects",
      "note.md",
      "folder/note.md",
      "folder",
      "folder",
    ];
    metadataStore.data.files = {
      "folder/child.md": {
        path: "folder/child.md",
        sha: "sha",
        dirty: false,
        justDownloaded: false,
        lastModified: 1,
      },
      "note.md": {
        path: "note.md",
        sha: "sha",
        dirty: false,
        justDownloaded: false,
        lastModified: 1,
        deleted: true,
      },
    };

    await (syncManager as any).loadMetadata();

    expect(metadataStore.data.deletedFolders).toEqual([
      "Projects",
      "folder",
    ]);
  });

  it("force-removes leftover files when processing a deleted folder", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({ lastSync: 0, files: {} }),
      "Ghost Folder/.DS_Store": "hidden",
      "Ghost Folder/child/note.md": "content",
    });
    vault._dirs.add("Ghost Folder");
    vault._dirs.add("Ghost Folder/child");

    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );

    await (syncManager as any).removeDirectoryRecursive("Ghost Folder", {
      force: true,
    });

    expect(await vault.adapter.exists("Ghost Folder")).toBe(false);
    expect(vault.adapter.remove).toHaveBeenCalledWith("Ghost Folder/.DS_Store");
    expect(vault.adapter.remove).toHaveBeenCalledWith("Ghost Folder/child/note.md");
    expect(vault.adapter.rmdir).toHaveBeenCalledWith("Ghost Folder", false);
  });

  it("does not track file-like folder tombstones from malformed folder events", async () => {
    const metadataStore = createMockMetadataStore();
    const listener = new EventsListener(
      vault as any,
      metadataStore as any,
      settings,
      createMockLogger() as any,
    );
    const fakeFolder = Object.create(TFolder.prototype) as TFolder & {
      path: string;
    };
    fakeFolder.path = "bad.md";

    await (listener as any).onDelete(fakeFolder);

    expect(metadataStore.data.deletedFolders ?? []).toEqual([]);
  });

  it("tracks normal folder deletions as explicit delete intent", async () => {
    const metadataStore = createMockMetadataStore();
    const listener = new EventsListener(
      vault as any,
      metadataStore as any,
      settings,
      createMockLogger() as any,
    );
    const folder = Object.create(TFolder.prototype) as TFolder & { path: string };
    folder.path = "Projects";

    await (listener as any).onDelete(folder);

    expect(metadataStore.data.deletedFolders ?? []).toEqual(["Projects"]);
    expect(metadataStore.save).toHaveBeenCalledTimes(1);
  });

  it("converts legacy deletedFolders into per-file tombstones without deleting unknown files", async () => {
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore({
      "Projects/known.md": {
        path: "Projects/known.md",
        sha: "local-known-sha",
        dirty: false,
        justDownloaded: false,
        lastModified: 1,
      },
    });
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.getRepoContent.mockResolvedValue({
      files: {
        ".obsidian/github-sync-metadata.json": makeTreeFile(
          ".obsidian/github-sync-metadata.json",
          "manifest-sha",
        ),
      },
      sha: "tree-sha",
    });
    client.getBlob.mockResolvedValue({
      content: Buffer.from(
        JSON.stringify({
          lastSync: 0,
          files: {},
          deletedFolders: ["Projects"],
        }),
      ).toString("base64"),
    });
    (syncManager as any).client = client;

    const snapshot = await (syncManager as any).buildRemoteSnapshot();

    expect(snapshot.metadata.deletedFolders).toEqual(["Projects"]);
    expect(snapshot.metadata.files["Projects/known.md"]).toMatchObject({
      path: "Projects/known.md",
      deleted: true,
    });
    expect(snapshot.metadata.files["Projects/unknown.md"]).toBeUndefined();
  });

  it("removes an explicitly deleted folder only when it is empty after file reconciliation", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({ lastSync: 0, files: {} }),
    });
    vault._dirs.add("Projects");

    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );

    const removed = await (syncManager as any).applyExplicitFolderDeletes([
      { path: "Projects", deletedAt: null },
    ]);

    expect(removed.has("Projects")).toBe(true);
    expect(await vault.adapter.exists("Projects")).toBe(false);
  });

  it("keeps an explicitly deleted folder when newer descendants remain", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({ lastSync: 0, files: {} }),
      "Projects/new.md": "local content",
    });

    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );

    const removed = await (syncManager as any).applyExplicitFolderDeletes([
      { path: "Projects", deletedAt: null },
    ]);

    expect(removed.has("Projects")).toBe(false);
    expect(await vault.adapter.exists("Projects")).toBe(true);
    expect(await vault.adapter.exists("Projects/new.md")).toBe(true);
  });
});
