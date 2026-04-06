import { vi } from "vitest";
import { FileMetadata, FolderMetadata, Metadata } from "../metadata-store";

/**
 * Creates a mock Vault adapter with in-memory file system.
 */
export function createMockVault(files: Record<string, string | ArrayBuffer> = {}) {
  const store: Record<string, string | ArrayBuffer> = { ...files };
  const dirs = new Set<string>();

  function addParentDirs(path: string) {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      dirs.add(current);
    }
  }

  Object.keys(store).forEach(addParentDirs);

  const adapter = {
    read: vi.fn(async (path: string) => {
      if (!(path in store)) throw new Error(`File not found: ${path}`);
      const content = store[path];
      if (typeof content !== "string") throw new Error(`Cannot read binary as text: ${path}`);
      return content;
    }),
    write: vi.fn(async (path: string, data: string) => {
      addParentDirs(path);
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
      addParentDirs(path);
      store[path] = data;
    }),
    exists: vi.fn(async (path: string) => {
      if (path in store || dirs.has(path)) {
        return true;
      }
      const prefix = path === "" || path === "/" ? "" : path + "/";
      return Object.keys(store).some((key) => key.startsWith(prefix));
    }),
    stat: vi.fn(async (path: string) => {
      if (path in store) {
        const content = store[path];
        return {
          type: "file",
          size: typeof content === "string" ? content.length : content.byteLength,
          ctime: Date.now(),
          mtime: Date.now(),
        };
      }
      if (dirs.has(path)) {
        return {
          type: "folder",
          size: 0,
          ctime: Date.now(),
          mtime: Date.now(),
        };
      }
      const prefix = path === "" || path === "/" ? "" : path + "/";
      if (Object.keys(store).some((key) => key.startsWith(prefix))) {
        return {
          type: "folder",
          size: 0,
          ctime: Date.now(),
          mtime: Date.now(),
        };
      }
      return null;
    }),
    mkdir: vi.fn(async (dirPath: string) => {
      dirs.add(dirPath);
    }),
    remove: vi.fn(async (path: string) => {
      delete store[path];
    }),
    rmdir: vi.fn(async (dirPath: string, recursive: boolean) => {
      const prefix = dirPath === "" || dirPath === "/" ? "" : dirPath + "/";
      const childFiles = Object.keys(store).filter((key) => key.startsWith(prefix));
      const childDirs = Array.from(dirs).filter((dir) => dir.startsWith(prefix));

      if (!recursive && (childFiles.length > 0 || childDirs.length > 0)) {
        throw new Error(`Directory not empty: ${dirPath}`);
      }

      childFiles.forEach((file) => delete store[file]);
      childDirs.forEach((dir) => dirs.delete(dir));
      dirs.delete(dirPath);
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
      for (const dir of Array.from(dirs)) {
        if (!dir.startsWith(prefix) || dir === dirPath) continue;
        const rest = dir.slice(prefix.length);
        const slashIdx = rest.indexOf("/");
        const folder = slashIdx === -1 ? dir : prefix + rest.slice(0, slashIdx);
        if (!seen.has(folder)) {
          seen.add(folder);
          foldersList.push(folder);
        }
      }
      return { files: filesList, folders: foldersList };
    }),
  };

  return {
    configDir: ".obsidian",
    getRoot: () => ({ path: "" }),
    getAbstractFileByPath: (path: string) => {
      if (path in store) {
        return { path };
      }
      if (dirs.has(path)) {
        return { path, children: [], isRoot: () => path === "" };
      }
      const prefix = path === "" || path === "/" ? "" : path + "/";
      if (Object.keys(store).some((key) => key.startsWith(prefix))) {
        return { path, children: [], isRoot: () => path === "" };
      }
      return null;
    },
    getAllLoadedFiles: () => [
      { path: "", children: [], isRoot: () => true },
      ...Array.from(dirs).map((path) => ({
        path,
        children: [],
        isRoot: () => path === "",
      })),
      ...Object.keys(store).map((path) => ({ path })),
    ],
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
export function createMockMetadataStore(
  initialFiles: Record<string, FileMetadata> = {},
  initialFolders: Record<string, FolderMetadata> = {},
) {
  const data: Metadata = {
    lastSync: 0,
    files: { ...initialFiles },
    folders: { ...initialFolders },
  };

  return {
    data,
    load: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    reset: vi.fn(() => {
      data.lastSync = 0;
      data.files = {};
      data.folders = {};
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
