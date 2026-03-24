import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockVault, createMockLogger, makeFileMetadata, createMockGithubClient } from "./helpers";
import SyncManager from "../sync-manager";

/**
 * Tests for determineSyncActions() — the core logic that decides
 * what to upload, download, delete locally, or delete remotely.
 */
describe("determineSyncActions", () => {
  let vault: ReturnType<typeof createMockVault>;
  let syncManager: SyncManager;

  beforeEach(() => {
    vault = createMockVault({
      ".obsidian/github-sync-metadata.json": JSON.stringify({ lastSync: 0, files: {} }),
    });
    const settings = {
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
    syncManager = new SyncManager(
      vault as any,
      settings,
      async () => [],
      createMockLogger() as any,
    );
  });

  // Helper to call the private method
  async function callDetermineSyncActions(
    remoteFiles: Record<string, any>,
    localFiles: Record<string, any>,
    conflictFiles: string[] = [],
  ) {
    return (syncManager as any).determineSyncActions(remoteFiles, localFiles, conflictFiles);
  }

  // Helper to make calculateSHA return specific values
  function mockCalculateSHA(shaMap: Record<string, string | null>) {
    (syncManager as any).calculateSHA = vi.fn(async (path: string) => {
      return shaMap[path] ?? null;
    });
  }

  describe("common files — both sides have the file", () => {
    it("skips when both sides are deleted", async () => {
      mockCalculateSHA({});
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { deleted: true, deletedAt: 1000 }) },
        { "note.md": makeFileMetadata("note.md", { deleted: true, deletedAt: 900 }) },
      );
      expect(actions).toHaveLength(0);
    });

    it("returns upload when remote deleted and local was actually edited", async () => {
      // Local SHA differs from stored SHA = local was edited
      mockCalculateSHA({ "note.md": "new_local_sha" });
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { deleted: true, deletedAt: 2000 }) },
        { "note.md": makeFileMetadata("note.md", { sha: "old_sha", lastModified: 1000 }) },
      );
      expect(actions).toContainEqual({ type: "upload", filePath: "note.md" });
    });

    it("returns delete_local when remote deleted and local was NOT edited", async () => {
      // Local SHA matches stored SHA = local unchanged, propagate delete
      mockCalculateSHA({ "note.md": "same_sha" });
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { deleted: true, deletedAt: 2000 }) },
        { "note.md": makeFileMetadata("note.md", { sha: "same_sha", lastModified: 1000 }) },
      );
      expect(actions).toContainEqual({ type: "delete_local", filePath: "note.md" });
    });

    it("returns download when local deleted and remote was actually edited", async () => {
      // Remote SHA differs from stored SHA = remote was edited by another device
      mockCalculateSHA({ "note.md": "abc123" });
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { sha: "new_remote_sha", lastModified: 2000 }) },
        { "note.md": makeFileMetadata("note.md", { sha: "old_sha", deleted: true, deletedAt: 1000 }) },
      );
      expect(actions).toContainEqual({ type: "download", filePath: "note.md" });
    });

    it("returns delete_remote when local deleted and remote was NOT edited", async () => {
      // Remote SHA matches stored SHA = remote unchanged, propagate delete
      mockCalculateSHA({ "note.md": "abc123" });
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { sha: "same_sha", lastModified: 1000 }) },
        { "note.md": makeFileMetadata("note.md", { sha: "same_sha", deleted: true, deletedAt: 2000 }) },
      );
      expect(actions).toContainEqual({ type: "delete_remote", filePath: "note.md" });
    });

    it("skips when SHAs match (file unchanged)", async () => {
      mockCalculateSHA({ "note.md": "same_sha" });
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { sha: "same_sha" }) },
        { "note.md": makeFileMetadata("note.md", { sha: "same_sha" }) },
      );
      expect(actions).toHaveLength(0);
    });

    it("returns upload when local file changed (local SHA differs from stored)", async () => {
      mockCalculateSHA({ "note.md": "new_local_sha" });
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { sha: "remote_sha" }) },
        { "note.md": makeFileMetadata("note.md", { sha: "old_sha" }) },
      );
      expect(actions).toContainEqual({ type: "upload", filePath: "note.md" });
    });

    it("returns download when remote file changed but local unchanged", async () => {
      mockCalculateSHA({ "note.md": "stored_sha" });
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { sha: "new_remote_sha" }) },
        { "note.md": makeFileMetadata("note.md", { sha: "stored_sha" }) },
      );
      expect(actions).toContainEqual({ type: "download", filePath: "note.md" });
    });

    it("skips manifest file", async () => {
      mockCalculateSHA({});
      const actions = await callDetermineSyncActions(
        { ".obsidian/github-sync-metadata.json": makeFileMetadata(".obsidian/github-sync-metadata.json", { sha: "a" }) },
        { ".obsidian/github-sync-metadata.json": makeFileMetadata(".obsidian/github-sync-metadata.json", { sha: "b" }) },
      );
      expect(actions).toHaveLength(0);
    });

    it("excludes files already in conflictFiles list", async () => {
      mockCalculateSHA({ "note.md": "new_sha" });
      const actions = await callDetermineSyncActions(
        { "note.md": makeFileMetadata("note.md", { sha: "remote_sha" }) },
        { "note.md": makeFileMetadata("note.md", { sha: "old_sha" }) },
        ["note.md"],
      );
      expect(actions).toHaveLength(0);
    });
  });

  describe("remote-only files", () => {
    it("returns download for new remote file", async () => {
      mockCalculateSHA({});
      const actions = await callDetermineSyncActions(
        { "new-remote.md": makeFileMetadata("new-remote.md") },
        {},
      );
      expect(actions).toContainEqual({ type: "download", filePath: "new-remote.md" });
    });

    it("skips deleted remote-only files", async () => {
      mockCalculateSHA({});
      const actions = await callDetermineSyncActions(
        { "deleted.md": makeFileMetadata("deleted.md", { deleted: true }) },
        {},
      );
      expect(actions).toHaveLength(0);
    });
  });

  describe("local-only files", () => {
    it("returns upload for new local file", async () => {
      mockCalculateSHA({});
      const actions = await callDetermineSyncActions(
        {},
        { "new-local.md": makeFileMetadata("new-local.md") },
      );
      expect(actions).toContainEqual({ type: "upload", filePath: "new-local.md" });
    });

    it("skips deleted local-only files", async () => {
      mockCalculateSHA({});
      const actions = await callDetermineSyncActions(
        {},
        { "deleted.md": makeFileMetadata("deleted.md", { deleted: true }) },
      );
      expect(actions).toHaveLength(0);
    });
  });

  describe("config dir filtering", () => {
    it("filters out config dir actions when syncConfigDir is false", async () => {
      mockCalculateSHA({});
      const actions = await callDetermineSyncActions(
        { ".obsidian/plugins/foo/data.json": makeFileMetadata(".obsidian/plugins/foo/data.json") },
        {},
      );
      // Config dir files should be filtered out (except manifest)
      const configActions = actions.filter(
        (a: any) => a.filePath.startsWith(".obsidian") && a.filePath !== ".obsidian/github-sync-metadata.json",
      );
      expect(configActions).toHaveLength(0);
    });
  });
});
