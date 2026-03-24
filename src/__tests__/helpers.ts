import { vi } from "vitest";
import { FileMetadata, Metadata } from "../metadata-store";

/**
 * Creates a mock Vault adapter with in-memory file system.
 */
export function createMockVault(files: Record<string, string | ArrayBuffer> = {}) {
  const store: Record<string, string | ArrayBuffer> = { ...files };
  const dirs = new Set<string>();

  const adapter = {
    read: vi.fn(async (path: string) => {
      if (!(path in store)) throw new Error(`File not found: ${path}`);
      const content = store[path];
      if (typeof content !== "string") throw new Error(`Cannot read binary as text: ${path}`);
      return content;
    }),
    write: vi.fn(async (path: string, data: string) => {
      store[path] = data;
    }),
    readBinary: vi.fn(async (path: string) => {
      if (!(path in store)) throw new Error(`File not found: ${path}`);
      const content = store[path];
      if (typeof content === "string") {
        return new TextEncoder().encode(content).buffer;
      }
      return content;
    }),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      store[path] = data;
    }),
    exists: vi.fn(async (path: string) => path in store),
    mkdir: vi.fn(async (dirPath: string) => {
      dirs.add(dirPath);
    }),
    remove: vi.fn(async (path: string) => {
      delete store[path];
    }),
    list: vi.fn(async (dirPath: string) => {
      const prefix = dirPath === "" || dirPath === "/" ? "" : dirPath + "/";
      const filesList: string[] = [];
      const foldersList: string[] = [];
      const seen = new Set<string>();

      for (const key of Object.keys(store)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx === -1) {
          filesList.push(key);
        } else {
          const folder = prefix + rest.slice(0, slashIdx);
          if (!seen.has(folder)) {
            seen.add(folder);
            foldersList.push(folder);
          }
        }
      }
      return { files: filesList, folders: foldersList };
    }),
  };

  return {
    configDir: ".obsidian",
    getRoot: () => ({ path: "" }),
    adapter,
    on: vi.fn(),
    // Expose store for test assertions
    _store: store,
    _dirs: dirs,
  };
}

/**
 * Creates a mock MetadataStore.
 */
export function createMockMetadataStore(initialFiles: Record<string, FileMetadata> = {}) {
  const data: Metadata = {
    lastSync: 0,
    files: { ...initialFiles },
  };

  return {
    data,
    load: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    reset: vi.fn(() => {
      data.lastSync = 0;
      data.files = {};
    }),
  };
}

/**
 * Creates a mock GithubClient.
 */
export function createMockGithubClient() {
  return {
    getRepoContent: vi.fn(),
    createTree: vi.fn(),
    createCommit: vi.fn(),
    getBranchHeadSha: vi.fn(),
    updateBranchHead: vi.fn(),
    createBlob: vi.fn(),
    getBlob: vi.fn(),
    createFile: vi.fn(),
    downloadRepositoryArchive: vi.fn(),
  };
}

/**
 * Creates a mock Logger.
 */
export function createMockLogger() {
  return {
    info: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
  };
}

/**
 * Helper to create a FileMetadata entry.
 */
export function makeFileMetadata(
  path: string,
  overrides: Partial<FileMetadata> = {},
): FileMetadata {
  return {
    path,
    sha: "abc123",
    dirty: false,
    justDownloaded: false,
    lastModified: 1000,
    ...overrides,
  };
}

/**
 * Helper to create a remote tree file entry.
 */
export function makeTreeFile(
  path: string,
  sha: string = "abc123",
) {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha,
    size: 100,
    url: `https://api.github.com/repos/test/test/git/blobs/${sha}`,
  };
}
