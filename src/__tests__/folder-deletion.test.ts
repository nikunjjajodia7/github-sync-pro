import { beforeEach, describe, expect, it } from "vitest";
import { TFolder } from "obsidian";
import SyncManager from "../sync-manager";
import EventsListener from "../events-listener";
import {
  createMockLogger,
  createMockMetadataStore,
  createMockVault,
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
});
