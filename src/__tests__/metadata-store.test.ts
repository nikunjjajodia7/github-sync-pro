import { describe, it, expect, beforeEach } from "vitest";
import { createMockVault } from "./helpers";
import MetadataStore from "../metadata-store";

describe("MetadataStore", () => {
  let vault: ReturnType<typeof createMockVault>;
  let store: MetadataStore;

  beforeEach(() => {
    vault = createMockVault();
    store = new MetadataStore(vault as any);
  });

  describe("load", () => {
    it("loads existing metadata from disk", async () => {
      const existingData = {
        lastSync: 1000,
        files: {
          "note.md": {
            path: "note.md",
            sha: "abc",
            dirty: false,
            justDownloaded: false,
            lastModified: 500,
          },
        },
      };
      vault._store[".obsidian/github-sync-metadata.json"] = JSON.stringify(existingData);

      await store.load();

      expect(store.data.lastSync).toBe(1000);
      expect(store.data.files["note.md"].sha).toBe("abc");
    });

    it("initializes empty state when file does not exist", async () => {
      await store.load();

      expect(store.data.lastSync).toBe(0);
      expect(Object.keys(store.data.files)).toHaveLength(0);
    });
  });

  describe("save", () => {
    it("writes metadata to disk", async () => {
      store.data = {
        lastSync: 2000,
        files: {
          "test.md": {
            path: "test.md",
            sha: "def",
            dirty: true,
            justDownloaded: false,
            lastModified: 1500,
          },
        },
      };

      await store.save();

      expect(vault.adapter.write).toHaveBeenCalledWith(
        ".obsidian/github-sync-metadata.json",
        expect.any(String),
      );
      const written = JSON.parse(
        (vault.adapter.write as any).mock.calls[0][1],
      );
      expect(written.lastSync).toBe(2000);
      expect(written.files["test.md"].sha).toBe("def");
    });

    it("serializes writes sequentially via write queue", async () => {
      store.data = { lastSync: 1, files: {} };

      // Fire multiple saves rapidly
      const p1 = store.save();
      store.data.lastSync = 2;
      const p2 = store.save();
      store.data.lastSync = 3;
      const p3 = store.save();

      await Promise.all([p1, p2, p3]);

      // All 3 should have been called
      expect(vault.adapter.write).toHaveBeenCalledTimes(3);
    });
  });

  describe("reset", () => {
    it("resets to empty state", () => {
      store.data = {
        lastSync: 5000,
        files: { "a.md": { path: "a.md", sha: "x", dirty: false, justDownloaded: false, lastModified: 0 } },
      };

      store.reset();

      expect(store.data.lastSync).toBe(0);
      expect(Object.keys(store.data.files)).toHaveLength(0);
    });
  });
});
