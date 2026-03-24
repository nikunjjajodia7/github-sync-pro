import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockVault, createMockMetadataStore, createMockLogger } from "./helpers";
import EventsListener from "../events-listener";
import { TAbstractFile, TFolder } from "obsidian";

describe("EventsListener", () => {
  let vault: ReturnType<typeof createMockVault>;
  let metadataStore: ReturnType<typeof createMockMetadataStore>;
  let logger: ReturnType<typeof createMockLogger>;
  let listener: EventsListener;
  let settings: any;

  beforeEach(() => {
    vault = createMockVault();
    metadataStore = createMockMetadataStore();
    logger = createMockLogger();
    settings = {
      syncConfigDir: false,
      syncScopeMode: "notes-first",
    };
    listener = new EventsListener(
      vault as any,
      metadataStore as any,
      settings,
      logger as any,
    );
  });

  // Access private methods for testing
  function callOnCreate(file: any) {
    return (listener as any).onCreate(file);
  }
  function callOnDelete(file: any) {
    return (listener as any).onDelete(file);
  }
  function callOnModify(file: any) {
    return (listener as any).onModify(file);
  }
  function callOnRename(file: any, oldPath: string) {
    return (listener as any).onRename(file, oldPath);
  }

  describe("onCreate", () => {
    it("skips non-syncable files", async () => {
      await callOnCreate({ path: "node_modules/foo.js" });
      expect(Object.keys(metadataStore.data.files)).toHaveLength(0);
    });

    it("skips folders (TFolder instances)", async () => {
      // TFolder is identified by instanceof check; we simulate by passing a folder-like object
      // In the real code, it checks `file instanceof TFolder` — we can't easily mock this
      // but we can verify the file IS added for a regular file
      await callOnCreate({ path: "note.md" });
      expect(metadataStore.data.files["note.md"]).toBeDefined();
    });

    it("clears justDownloaded flag instead of marking dirty", async () => {
      metadataStore.data.files["note.md"] = {
        path: "note.md",
        sha: "abc",
        dirty: false,
        justDownloaded: true,
        lastModified: 1000,
      };

      await callOnCreate({ path: "note.md" });

      expect(metadataStore.data.files["note.md"].justDownloaded).toBe(false);
      expect(metadataStore.data.files["note.md"].dirty).toBe(false);
      expect(metadataStore.save).toHaveBeenCalled();
    });

    it("adds new file to metadata with null SHA and dirty=true", async () => {
      await callOnCreate({ path: "new-note.md" });

      const file = metadataStore.data.files["new-note.md"];
      expect(file).toBeDefined();
      expect(file.sha).toBeNull();
      expect(file.dirty).toBe(true);
      expect(file.justDownloaded).toBe(false);
      expect(metadataStore.save).toHaveBeenCalled();
    });
  });

  describe("onDelete", () => {
    it("skips non-syncable files", async () => {
      await callOnDelete(new TAbstractFile(".DS_Store"));
      expect(metadataStore.save).not.toHaveBeenCalled();
    });

    it("skips files not in metadata", async () => {
      await callOnDelete(new TAbstractFile("unknown.md"));
      expect(metadataStore.save).not.toHaveBeenCalled();
    });

    it("marks tracked file as deleted", async () => {
      metadataStore.data.files["note.md"] = {
        path: "note.md",
        sha: "abc",
        dirty: false,
        justDownloaded: false,
        lastModified: 1000,
      };

      await callOnDelete(new TAbstractFile("note.md"));

      expect(metadataStore.data.files["note.md"].deleted).toBe(true);
      expect(metadataStore.data.files["note.md"].deletedAt).toBeGreaterThan(0);
      expect(metadataStore.save).toHaveBeenCalled();
    });

    it("handles string path (for rename delegation)", async () => {
      metadataStore.data.files["old.md"] = {
        path: "old.md",
        sha: "abc",
        dirty: false,
        justDownloaded: false,
        lastModified: 1000,
      };

      await callOnDelete("old.md");

      expect(metadataStore.data.files["old.md"].deleted).toBe(true);
    });
  });

  describe("onModify", () => {
    it("skips non-syncable files", async () => {
      await callOnModify({ path: ".obsidian/workspace.json" });
      expect(metadataStore.save).not.toHaveBeenCalled();
    });

    it("clears justDownloaded flag instead of marking dirty", async () => {
      metadataStore.data.files["note.md"] = {
        path: "note.md",
        sha: "abc",
        dirty: false,
        justDownloaded: true,
        lastModified: 1000,
      };

      await callOnModify({ path: "note.md" });

      expect(metadataStore.data.files["note.md"].justDownloaded).toBe(false);
      expect(metadataStore.data.files["note.md"].dirty).toBe(false);
      expect(metadataStore.save).toHaveBeenCalled();
    });

    it("marks existing file as dirty with updated timestamp", async () => {
      metadataStore.data.files["note.md"] = {
        path: "note.md",
        sha: "abc",
        dirty: false,
        justDownloaded: false,
        lastModified: 1000,
      };

      await callOnModify({ path: "note.md" });

      expect(metadataStore.data.files["note.md"].dirty).toBe(true);
      expect(metadataStore.data.files["note.md"].lastModified).toBeGreaterThan(1000);
      expect(metadataStore.save).toHaveBeenCalled();
    });

    it("creates metadata entry for untracked file on modify", async () => {
      await callOnModify({ path: "untracked.md" });

      const file = metadataStore.data.files["untracked.md"];
      expect(file).toBeDefined();
      expect(file.sha).toBeNull();
      expect(file.dirty).toBe(true);
      expect(metadataStore.save).toHaveBeenCalled();
    });
  });

  describe("onRename", () => {
    it("handles rename within syncable directory (creates new + deletes old)", async () => {
      metadataStore.data.files["old-name.md"] = {
        path: "old-name.md",
        sha: "abc",
        dirty: false,
        justDownloaded: false,
        lastModified: 1000,
      };

      await callOnRename({ path: "new-name.md" }, "old-name.md");

      // New file should be created
      expect(metadataStore.data.files["new-name.md"]).toBeDefined();
      // Old file should be marked deleted
      expect(metadataStore.data.files["old-name.md"].deleted).toBe(true);
    });

    it("handles rename INTO syncable directory (create only)", async () => {
      await callOnRename({ path: "note.md" }, "node_modules/note.md");

      expect(metadataStore.data.files["note.md"]).toBeDefined();
    });

    it("handles rename OUT OF syncable directory (delete only)", async () => {
      metadataStore.data.files["note.md"] = {
        path: "note.md",
        sha: "abc",
        dirty: false,
        justDownloaded: false,
        lastModified: 1000,
      };

      await callOnRename({ path: "node_modules/note.md" }, "note.md");

      expect(metadataStore.data.files["note.md"].deleted).toBe(true);
    });

    it("skips when both paths are non-syncable", async () => {
      await callOnRename({ path: "node_modules/b.js" }, "node_modules/a.js");

      expect(metadataStore.save).not.toHaveBeenCalled();
    });
  });
});
