import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the obsidian module using the project's mock-obsidian
vi.mock("obsidian", async () => {
  return await import("../../mock-obsidian");
});

import MetadataStore from "../metadata-store";

// Minimal in-memory Vault mock (no filesystem needed)
function createMockVault() {
  const storage: Record<string, string> = {};
  return {
    configDir: ".obsidian",
    adapter: {
      exists: vi.fn(async (path: string) => path in storage),
      read: vi.fn(async (path: string) => storage[path]),
      write: vi.fn(async (path: string, data: string) => {
        storage[path] = data;
      }),
    },
    // Expose storage for assertions
    _storage: storage,
  };
}

describe("MetadataStore", () => {
  let vault: ReturnType<typeof createMockVault>;
  let store: MetadataStore;

  beforeEach(() => {
    vault = createMockVault();
    store = new MetadataStore(vault as any);
  });

  it("has initial data with lastSync: 0 and empty files after load", async () => {
    await store.load();
    expect(store.data.lastSync).toBe(0);
    expect(store.data.files).toEqual({});
  });

  it("reset() clears data back to defaults", async () => {
    await store.load();
    store.data.lastSync = 12345;
    store.data.files["test.md"] = {
      path: "test.md",
      sha: "abc123",
      dirty: false,
      justDownloaded: false,
      lastModified: 100,
    };
    store.reset();
    expect(store.data.lastSync).toBe(0);
    expect(store.data.files).toEqual({});
  });

  it("can set and get file metadata", async () => {
    await store.load();
    const metadata = {
      path: "notes/hello.md",
      sha: "sha256abc",
      dirty: true,
      justDownloaded: false,
      lastModified: Date.now(),
    };
    store.data.files["notes/hello.md"] = metadata;
    expect(store.data.files["notes/hello.md"]).toEqual(metadata);
    expect(store.data.files["notes/hello.md"].sha).toBe("sha256abc");
    expect(store.data.files["notes/hello.md"].dirty).toBe(true);
  });

  it("loads existing data from vault", async () => {
    const existingData = {
      lastSync: 999,
      files: {
        "a.md": {
          path: "a.md",
          sha: "xyz",
          dirty: false,
          justDownloaded: false,
          lastModified: 50,
        },
      },
    };
    // Pre-populate storage
    vault._storage[".obsidian/github-sync-metadata.json"] = JSON.stringify(existingData);
    await store.load();
    expect(store.data.lastSync).toBe(999);
    expect(store.data.files["a.md"].sha).toBe("xyz");
  });
});
