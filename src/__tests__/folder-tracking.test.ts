import { createHash } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import SyncManager from "../sync-manager";
import {
  createMockGithubClient,
  createMockLogger,
  createMockMetadataStore,
  createMockVault,
  makeTreeFile,
} from "./helpers";

function gitBlobSha(content: string): string {
  return createHash("sha1")
    .update(`blob ${content.length}\0${content}`)
    .digest("hex");
}

describe("folder tracking", () => {
  let vault: ReturnType<typeof createMockVault>;
  let settings: any;

  beforeEach(() => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
      "Research/CiDRA/00_Index.md": "# Index",
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

  it("adopts missing local files and folders into metadata during local snapshot build", async () => {
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore();
    (syncManager as any).metadataStore = metadataStore;

    const remoteSnapshot = {
      explicitFolderDeletes: [],
      metadata: { lastSync: 0, files: {}, folders: {} },
      metadataChanged: false,
      treeFiles: {},
      treeSha: "tree-sha",
    };

    const snapshot = await (syncManager as any).buildLocalSnapshot(remoteSnapshot);

    expect(snapshot.metadataChanged).toBe(true);
    expect(metadataStore.data.files["Research/CiDRA/00_Index.md"]).toMatchObject({
      path: "Research/CiDRA/00_Index.md",
      sha: null,
      dirty: true,
    });
    expect(metadataStore.data.folders?.Research).toMatchObject({
      path: "Research",
      deleted: false,
    });
    expect(metadataStore.data.folders?.["Research/CiDRA"]).toMatchObject({
      path: "Research/CiDRA",
      deleted: false,
    });
  });

  it("commits adopted local empty folders when remote state is missing them", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
    });
    vault._dirs.add("Projects");

    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore();
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.getBranchHeadSha.mockResolvedValue("head-sha");
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
          folders: {},
        }),
      ).toString("base64"),
    });
    client.createTree.mockResolvedValue("new-tree-sha");
    client.createCommit.mockResolvedValue("commit-sha");
    client.updateBranchHead.mockResolvedValue(undefined);
    (syncManager as any).client = client;

    await (syncManager as any).syncImpl();

    expect(metadataStore.data.folders?.Projects).toMatchObject({
      path: "Projects",
      deleted: false,
    });
    expect(client.createCommit).toHaveBeenCalledTimes(1);
    const manifestEntry = client.createTree.mock.calls[0][0].tree.tree.find(
      (item: any) => item.path === ".obsidian/github-sync-metadata.json",
    );
    const manifest = JSON.parse(manifestEntry.content);
    expect(manifest.folders.Projects).toMatchObject({
      path: "Projects",
      deleted: false,
    });
  });

  it("adopts loaded empty folders even when adapter listing lags behind", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
    });
    vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
    (vault as any).getAllLoadedFiles = () => [
      { path: "", children: [], isRoot: () => true },
      { path: "Projects", children: [] },
    ];

    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore();
    (syncManager as any).metadataStore = metadataStore;

    const adopted = await (syncManager as any).adoptMissingLocalFolderMetadataEntries();

    expect(adopted).toBe(1);
    expect(metadataStore.data.folders?.Projects).toMatchObject({
      path: "Projects",
      deleted: false,
    });
  });

  it("creates remote empty folders locally without treating them as remote work", async () => {
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );

    const metadataStore = createMockMetadataStore();
    (syncManager as any).metadataStore = metadataStore;

    const result = await (syncManager as any).reconcileRemoteFolders({
      Empty: {
        path: "Empty",
        deleted: false,
        deletedAt: null,
        lastModified: 1,
      },
      "Empty/Nested": {
        path: "Empty/Nested",
        deleted: false,
        deletedAt: null,
        lastModified: 1,
      },
    });

    expect(result.createdLocalFolders).toEqual(["Empty", "Empty/Nested"]);
    expect(result.metadataChanged).toBe(true);
    expect(await vault.adapter.exists("Empty")).toBe(true);
    expect(await vault.adapter.exists("Empty/Nested")).toBe(true);
    expect(metadataStore.data.folders?.Empty).toMatchObject({
      path: "Empty",
      deleted: false,
    });
  });

  it("persists folders in the manifest and derives legacy deletedFolders", async () => {
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore(
      {
        "Projects/keep.md": {
          path: "Projects/keep.md",
          sha: "local-sha",
          dirty: false,
          justDownloaded: false,
          lastModified: 1,
        },
      },
      {
        Projects: {
          path: "Projects",
          deleted: false,
          deletedAt: null,
          lastModified: 1,
        },
        Ghost: {
          path: "Ghost",
          deleted: true,
          deletedAt: 1,
          lastModified: 1,
        },
      },
    );
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.createTree.mockResolvedValue("new-tree-sha");
    client.getBranchHeadSha.mockResolvedValue("head-sha");
    client.createCommit.mockResolvedValue("commit-sha");
    client.updateBranchHead.mockResolvedValue(undefined);
    (syncManager as any).client = client;

    const manifestPath = ".obsidian/github-sync-metadata.json";
    const treeFiles = {
      [manifestPath]: {
        path: manifestPath,
        mode: "100644",
        type: "blob",
        sha: "manifest-sha",
      },
      "Projects/keep.md": {
        path: "Projects/keep.md",
        mode: "100644",
        type: "blob",
        sha: "local-sha",
      },
    };

    await (syncManager as any).commitSync(
      treeFiles,
      "base-tree-sha",
      [],
      "head-sha",
    );

    const manifest = JSON.parse((treeFiles as any)[manifestPath].content);
    expect(manifest.folders.Projects).toMatchObject({
      path: "Projects",
      deleted: false,
    });
    expect(manifest.folders.Ghost).toMatchObject({
      path: "Ghost",
      deleted: true,
    });
    expect(manifest.deletedFolders).toEqual(["Ghost"]);
  });

  it("marks uploaded files clean in both local and remote manifest state", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
      "Projects/keep.md": "# keep",
    });
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore({
      "Projects/keep.md": {
        path: "Projects/keep.md",
        sha: null,
        dirty: true,
        justDownloaded: false,
        lastModified: 1,
      },
    });
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.createTree.mockResolvedValue("new-tree-sha");
    client.getBranchHeadSha.mockResolvedValue("head-sha");
    client.createCommit.mockResolvedValue("commit-sha");
    client.updateBranchHead.mockResolvedValue(undefined);
    (syncManager as any).client = client;

    const manifestPath = ".obsidian/github-sync-metadata.json";
    const treeFiles = {
      [manifestPath]: {
        path: manifestPath,
        mode: "100644",
        type: "blob",
        sha: "manifest-sha",
      },
      "Projects/keep.md": {
        path: "Projects/keep.md",
        mode: "100644",
        type: "blob",
        content: "# keep",
      },
    };

    await (syncManager as any).commitSync(
      treeFiles,
      "base-tree-sha",
      [],
      "head-sha",
    );

    const manifest = JSON.parse((treeFiles as any)[manifestPath].content);
    expect(manifest.files["Projects/keep.md"].dirty).toBe(false);
    expect(manifest.files["Projects/keep.md"].deleted).toBeUndefined();
    expect(metadataStore.data.files["Projects/keep.md"]).toMatchObject({
      dirty: false,
    });
  });

  it("marks empty uploaded text files clean when content is empty", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
      "Projects/empty.md": "",
    });
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore({
      "Projects/empty.md": {
        path: "Projects/empty.md",
        sha: null,
        dirty: true,
        justDownloaded: false,
        lastModified: 1,
      },
    });
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.createTree.mockResolvedValue("new-tree-sha");
    client.getBranchHeadSha.mockResolvedValue("head-sha");
    client.createCommit.mockResolvedValue("commit-sha");
    client.updateBranchHead.mockResolvedValue(undefined);
    (syncManager as any).client = client;

    const manifestPath = ".obsidian/github-sync-metadata.json";
    const treeFiles = {
      [manifestPath]: {
        path: manifestPath,
        mode: "100644",
        type: "blob",
        sha: "manifest-sha",
      },
      "Projects/empty.md": {
        path: "Projects/empty.md",
        mode: "100644",
        type: "blob",
        content: "",
      },
    };

    await (syncManager as any).commitSync(
      treeFiles,
      "base-tree-sha",
      [],
      "head-sha",
    );

    const manifest = JSON.parse((treeFiles as any)[manifestPath].content);
    expect(manifest.files["Projects/empty.md"].dirty).toBe(false);
    expect(metadataStore.data.files["Projects/empty.md"].dirty).toBe(false);
  });

  it("keeps confirmed deleted folders durable in manifest state", async () => {
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore(
      {
        "Projects/old.md": {
          path: "Projects/old.md",
          sha: "old-sha",
          dirty: false,
          justDownloaded: false,
          lastModified: 1,
          deleted: true,
          deletedAt: 1,
        },
      },
      {
        Projects: {
          path: "Projects",
          deleted: true,
          deletedAt: 1,
          lastModified: 1,
        },
      },
    );
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.createTree.mockResolvedValue("new-tree-sha");
    client.getBranchHeadSha.mockResolvedValue("head-sha");
    client.createCommit.mockResolvedValue("commit-sha");
    client.updateBranchHead.mockResolvedValue(undefined);
    (syncManager as any).client = client;

    const manifestPath = ".obsidian/github-sync-metadata.json";
    const treeFiles = {
      [manifestPath]: {
        path: manifestPath,
        mode: "100644",
        type: "blob",
        sha: "manifest-sha",
      },
    };

    await (syncManager as any).commitSync(
      treeFiles,
      "base-tree-sha",
      [],
      "head-sha",
      [],
      {},
      new Set(["Projects"]),
    );

    const manifest = JSON.parse((treeFiles as any)[manifestPath].content);
    expect(manifest.folders.Projects).toMatchObject({
      path: "Projects",
      deleted: true,
    });
    expect(manifest.deletedFolders).toEqual(["Projects"]);
  });

  it("derives folder metadata from legacy remote deletedFolders", async () => {
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore();
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

    expect(snapshot.metadata.folders?.Projects).toMatchObject({
      path: "Projects",
      deleted: true,
    });
  });

  it("does not create a metadata-only commit when remote folders already exist and nothing changed", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
    });
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    vault._dirs.add("Projects");

    const metadataStore = createMockMetadataStore();
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.getBranchHeadSha.mockResolvedValue("head-sha");
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
          folders: {
            Projects: {
              path: "Projects",
              deleted: false,
              deletedAt: null,
              lastModified: 1,
            },
          },
        }),
      ).toString("base64"),
    });
    (syncManager as any).client = client;

    await (syncManager as any).syncImpl();

    expect(client.createTree).not.toHaveBeenCalled();
    expect(client.createCommit).not.toHaveBeenCalled();
  });

  it("creates the manifest entry during metadata-only commits when the remote manifest is missing", async () => {
    const readmeContent = "# seed\n";
    const readmeSha = gitBlobSha(readmeContent);

    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
      "README.md": readmeContent,
    });
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore(
      {
        "README.md": {
          path: "README.md",
          sha: readmeSha,
          dirty: false,
          justDownloaded: false,
          lastModified: 1,
        },
      },
      {
        Docs: {
          path: "Docs",
          deleted: false,
          deletedAt: null,
          lastModified: 1,
        },
      },
    );
    (syncManager as any).metadataStore = metadataStore;
    vault._dirs.add("Docs");

    const client = createMockGithubClient();
    client.getBranchHeadSha.mockResolvedValue("head-sha");
    client.getRepoContent.mockResolvedValue({
      files: {
        "README.md": makeTreeFile("README.md", readmeSha),
      },
      sha: "tree-sha",
    });
    client.createTree.mockResolvedValue("new-tree-sha");
    client.createCommit.mockResolvedValue("commit-sha");
    client.updateBranchHead.mockResolvedValue(undefined);
    (syncManager as any).client = client;

    await (syncManager as any).syncImpl();

    expect(client.createCommit).toHaveBeenCalledTimes(1);
    const manifestEntry = client.createTree.mock.calls[0][0].tree.tree.find(
      (item: any) => item.path === ".obsidian/github-sync-metadata.json",
    );
    expect(manifestEntry).toBeDefined();
    const manifest = JSON.parse(manifestEntry.content);
    expect(manifest.files["README.md"]).toMatchObject({
      path: "README.md",
      sha: readmeSha,
      dirty: false,
    });
    expect(manifest.folders.Docs).toMatchObject({
      path: "Docs",
      deleted: false,
    });
  });

  it("commits local empty folder creation with no file actions", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
    });
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    vault._dirs.add("Projects");

    const metadataStore = createMockMetadataStore(
      {},
      {
        Projects: {
          path: "Projects",
          deleted: false,
          deletedAt: null,
          lastModified: 1,
        },
      },
    );
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.getBranchHeadSha.mockResolvedValue("head-sha");
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
          folders: {},
        }),
      ).toString("base64"),
    });
    client.createTree.mockResolvedValue("new-tree-sha");
    client.createCommit.mockResolvedValue("commit-sha");
    client.updateBranchHead.mockResolvedValue(undefined);
    (syncManager as any).client = client;

    await (syncManager as any).syncImpl();

    expect(client.createCommit).toHaveBeenCalledTimes(1);
    const manifestEntry = client.createTree.mock.calls[0][0].tree.tree.find(
      (item: any) => item.path === ".obsidian/github-sync-metadata.json",
    );
    const manifest = JSON.parse(manifestEntry.content);
    expect(manifest.folders.Projects).toMatchObject({
      path: "Projects",
      deleted: false,
    });
  });

  it("commits local empty folder rename with no file actions", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
    });
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    vault._dirs.add("Archive");

    const metadataStore = createMockMetadataStore(
      {},
      {
        Projects: {
          path: "Projects",
          deleted: true,
          deletedAt: 1,
          lastModified: 1,
        },
        Archive: {
          path: "Archive",
          deleted: false,
          deletedAt: null,
          lastModified: 1,
        },
      },
    );
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.getBranchHeadSha.mockResolvedValue("head-sha");
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
          folders: {
            Projects: {
              path: "Projects",
              deleted: false,
              deletedAt: null,
              lastModified: 1,
            },
          },
        }),
      ).toString("base64"),
    });
    client.createTree.mockResolvedValue("new-tree-sha");
    client.createCommit.mockResolvedValue("commit-sha");
    client.updateBranchHead.mockResolvedValue(undefined);
    (syncManager as any).client = client;

    await (syncManager as any).syncImpl();

    expect(client.createCommit).toHaveBeenCalledTimes(1);
    const manifestEntry = client.createTree.mock.calls[0][0].tree.tree.find(
      (item: any) => item.path === ".obsidian/github-sync-metadata.json",
    );
    const manifest = JSON.parse(manifestEntry.content);
    expect(manifest.folders.Archive).toMatchObject({
      path: "Archive",
      deleted: false,
    });
    expect(manifest.folders.Projects).toMatchObject({
      path: "Projects",
      deleted: true,
    });
    expect(manifest.deletedFolders).toEqual(["Projects"]);
  });

  it("creates missing remote empty folders locally without creating a remote commit", async () => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({
        lastSync: 0,
        files: {},
        folders: {},
      }),
    });
    const syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
    const metadataStore = createMockMetadataStore();
    (syncManager as any).metadataStore = metadataStore;

    const client = createMockGithubClient();
    client.getBranchHeadSha.mockResolvedValue("head-sha");
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
          folders: {
            Empty: {
              path: "Empty",
              deleted: false,
              deletedAt: null,
              lastModified: 1,
            },
          },
        }),
      ).toString("base64"),
    });
    (syncManager as any).client = client;

    await (syncManager as any).syncImpl();

    expect(await vault.adapter.exists("Empty")).toBe(true);
    expect(metadataStore.data.folders?.Empty).toMatchObject({
      path: "Empty",
      deleted: false,
    });
    expect(client.createTree).not.toHaveBeenCalled();
    expect(client.createCommit).not.toHaveBeenCalled();
  });
});
