import { describe, it, expect, beforeAll } from "vitest";
import { isTrackableSyncPath } from "../sync-scope";

// Obsidian monkey-patches Array and String prototypes with .contains and .last
// We need to polyfill these for the test environment.
beforeAll(() => {
  if (!Array.prototype.contains) {
    // @ts-ignore
    Array.prototype.contains = function (item: unknown) {
      return this.includes(item);
    };
  }
  if (!Array.prototype.last) {
    // @ts-ignore
    Array.prototype.last = function () {
      return this.length > 0 ? this[this.length - 1] : undefined;
    };
  }
  // @ts-ignore - Obsidian adds .contains to String.prototype too
  if (!String.prototype.contains) {
    // @ts-ignore
    String.prototype.contains = function (s: string) {
      return this.includes(s);
    };
  }
  // @ts-ignore - Obsidian adds .last to String.prototype
  if (!String.prototype.last) {
    // @ts-ignore
    String.prototype.last = function () {
      return this.length > 0 ? this[this.length - 1] : undefined;
    };
  }
});

const defaultOpts = {
  configDir: ".obsidian",
  manifestPath: ".obsidian/github-sync-metadata.json",
  logPath: ".obsidian/github-sync.log",
  syncConfigDir: false,
  syncScopeMode: "notes-first" as "notes-first" | "broad",
  includeManifest: true,
};

function opts(overrides: Partial<typeof defaultOpts> = {}) {
  return { ...defaultOpts, ...overrides };
}

describe("isTrackableSyncPath", () => {
  it("should track .md files in notes-first mode", () => {
    expect(isTrackableSyncPath("notes/hello.md", opts())).toBe(true);
  });

  it("should NOT track .mp3 files (excluded extension)", () => {
    expect(isTrackableSyncPath("audio/song.mp3", opts())).toBe(false);
  });

  it("should NOT track .DS_Store", () => {
    expect(isTrackableSyncPath(".DS_Store", opts())).toBe(false);
    expect(isTrackableSyncPath("subfolder/.DS_Store", opts())).toBe(false);
  });

  it("should NOT track workspace.json", () => {
    expect(isTrackableSyncPath(".obsidian/workspace.json", opts())).toBe(false);
  });

  it("should NOT track workspace-mobile.json", () => {
    expect(isTrackableSyncPath(".obsidian/workspace-mobile.json", opts())).toBe(false);
  });

  it("should NOT track .log files", () => {
    expect(isTrackableSyncPath("debug.log", opts())).toBe(false);
    expect(isTrackableSyncPath("subfolder/app.log", opts())).toBe(false);
  });

  it("should NOT track node_modules paths", () => {
    expect(isTrackableSyncPath("node_modules/pkg/index.js", opts())).toBe(false);
  });

  it("should NOT track files in configDir when syncConfigDir is false", () => {
    expect(
      isTrackableSyncPath(".obsidian/plugins/my-plugin/main.js", opts({ syncConfigDir: false })),
    ).toBe(false);
  });

  it("should track files in configDir when syncConfigDir is true", () => {
    expect(
      isTrackableSyncPath(".obsidian/plugins/my-plugin/data.json", opts({ syncConfigDir: true })),
    ).toBe(true);
  });

  it("should track manifest file when includeManifest is true", () => {
    expect(
      isTrackableSyncPath(".obsidian/github-sync-metadata.json", opts({ includeManifest: true })),
    ).toBe(true);
  });

  it("should NOT track manifest file when includeManifest is false", () => {
    expect(
      isTrackableSyncPath(
        ".obsidian/github-sync-metadata.json",
        opts({ includeManifest: false }),
      ),
    ).toBe(false);
  });

  it("in broad mode, non-standard extensions should be trackable", () => {
    expect(isTrackableSyncPath("data/file.xyz", opts({ syncScopeMode: "broad" }))).toBe(true);
    expect(isTrackableSyncPath("data/file.docx", opts({ syncScopeMode: "broad" }))).toBe(true);
  });

  it("in notes-first mode, non-standard extensions should NOT be trackable", () => {
    expect(isTrackableSyncPath("data/file.xyz", opts({ syncScopeMode: "notes-first" }))).toBe(
      false,
    );
    expect(isTrackableSyncPath("data/file.docx", opts({ syncScopeMode: "notes-first" }))).toBe(
      false,
    );
  });
});
