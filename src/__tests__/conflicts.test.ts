import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockVault, createMockLogger, makeFileMetadata, createMockGithubClient } from "./helpers";
import SyncManager from "../sync-manager";

describe("findConflicts", () => {
  let vault: ReturnType<typeof createMockVault>;
  let syncManager: SyncManager;

  beforeEach(async () => {
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
    // Load metadata so metadataStore.data is initialized
    await (syncManager as any).metadataStore.load();
  });

  function setLocalMetadata(files: Record<string, any>) {
    (syncManager as any).metadataStore.data.files = files;
  }

  function mockCalculateSHA(shaMap: Record<string, string | null>) {
    (syncManager as any).calculateSHA = vi.fn(async (path: string) => {
      return shaMap[path] ?? null;
    });
  }

  function mockGetBlob(content: string) {
    (syncManager as any).client.getBlob = vi.fn(async () => ({
      content: Buffer.from(content).toString("base64"),
    }));
  }

  it("returns empty array when no common files exist", async () => {
    setLocalMetadata({});
    const conflicts = await syncManager.findConflicts({
      "remote-only.md": makeFileMetadata("remote-only.md"),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("skips manifest file", async () => {
    const manifestPath = ".obsidian/github-sync-metadata.json";
    setLocalMetadata({
      [manifestPath]: makeFileMetadata(manifestPath, { sha: "old" }),
    });
    mockCalculateSHA({ [manifestPath]: "new_sha" });

    const conflicts = await syncManager.findConflicts({
      [manifestPath]: makeFileMetadata(manifestPath, { sha: "different" }),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("skips when both sides are deleted", async () => {
    setLocalMetadata({
      "note.md": makeFileMetadata("note.md", { deleted: true }),
    });
    const conflicts = await syncManager.findConflicts({
      "note.md": makeFileMetadata("note.md", { deleted: true }),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("skips when local SHA is null (no baseline)", async () => {
    setLocalMetadata({
      "note.md": makeFileMetadata("note.md", { sha: null }),
    });
    const conflicts = await syncManager.findConflicts({
      "note.md": makeFileMetadata("note.md", { sha: "remote_sha" }),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("skips when remote SHA is null (no baseline)", async () => {
    setLocalMetadata({
      "note.md": makeFileMetadata("note.md", { sha: "local_sha" }),
    });
    const conflicts = await syncManager.findConflicts({
      "note.md": makeFileMetadata("note.md", { sha: null }),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("skips when file does not exist on disk", async () => {
    setLocalMetadata({
      "missing.md": makeFileMetadata("missing.md", { sha: "old_sha" }),
    });
    mockCalculateSHA({ "missing.md": null });

    const conflicts = await syncManager.findConflicts({
      "missing.md": makeFileMetadata("missing.md", { sha: "new_sha" }),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("detects conflict when both sides changed and content differs", async () => {
    const baseSha = "base_sha";
    setLocalMetadata({
      "note.md": makeFileMetadata("note.md", { sha: baseSha }),
    });
    // Local file has new content (different SHA from base)
    mockCalculateSHA({ "note.md": "local_new_sha" });
    // Remote also changed (different SHA from base)
    mockGetBlob("remote content");

    vault._store["note.md"] = "local content";

    const conflicts = await syncManager.findConflicts({
      "note.md": makeFileMetadata("note.md", { sha: "remote_new_sha" }),
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].filePath).toBe("note.md");
    expect(conflicts[0].remoteContent).toBe("remote content");
    expect(conflicts[0].localContent).toBe("local content");
  });

  it("no conflict when both sides changed to same content", async () => {
    const baseSha = "base_sha";
    const sameSha = "same_new_sha";
    setLocalMetadata({
      "note.md": makeFileMetadata("note.md", { sha: baseSha }),
    });
    mockCalculateSHA({ "note.md": sameSha });

    const conflicts = await syncManager.findConflicts({
      "note.md": makeFileMetadata("note.md", { sha: sameSha }),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("no conflict when only remote changed", async () => {
    const baseSha = "base_sha";
    setLocalMetadata({
      "note.md": makeFileMetadata("note.md", { sha: baseSha }),
    });
    // Local file unchanged — actual SHA matches stored SHA
    mockCalculateSHA({ "note.md": baseSha });

    const conflicts = await syncManager.findConflicts({
      "note.md": makeFileMetadata("note.md", { sha: "remote_new_sha" }),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("no conflict when only local changed", async () => {
    const baseSha = "base_sha";
    setLocalMetadata({
      "note.md": makeFileMetadata("note.md", { sha: baseSha }),
    });
    mockCalculateSHA({ "note.md": "local_new_sha" });

    const conflicts = await syncManager.findConflicts({
      // Remote SHA matches base — remote unchanged
      "note.md": makeFileMetadata("note.md", { sha: baseSha }),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("auto-resolves binary conflict in ask mode (no throw)", async () => {
    const baseSha = "base_sha";
    setLocalMetadata({
      "image.png": makeFileMetadata("image.png", { sha: baseSha }),
    });
    mockCalculateSHA({ "image.png": "local_new_sha" });

    vault._store["image.png"] = "fake binary";

    // Binary conflicts in ask mode no longer throw — they return as
    // conflicts with empty content, to be auto-resolved as downloads
    const conflicts = await syncManager.findConflicts({
      "image.png": makeFileMetadata("image.png", { sha: "remote_new_sha" }),
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].filePath).toBe("image.png");
    expect(conflicts[0].remoteContent).toBe("");
    expect(conflicts[0].localContent).toBe("");
  });
});
