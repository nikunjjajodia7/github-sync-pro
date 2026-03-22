import { describe, it, expect, beforeAll } from "vitest";
import { isTrackableSyncPath, matchesExcludePattern } from "../sync-scope";

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
  excludePatterns: [] as string[],
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

  it("should exclude files matching user exclude patterns", () => {
    const patterns = ["!attachments/**", "!**/*.pdf"];
    expect(isTrackableSyncPath("attachments/image.png", opts({ excludePatterns: patterns }))).toBe(false);
    expect(isTrackableSyncPath("attachments/sub/deep.png", opts({ excludePatterns: patterns }))).toBe(false);
    expect(isTrackableSyncPath("notes/doc.pdf", opts({ excludePatterns: patterns }))).toBe(false);
    expect(isTrackableSyncPath("doc.pdf", opts({ excludePatterns: ["!*.pdf"] }))).toBe(false);
  });

  it("should NOT exclude files that don't match user patterns", () => {
    const patterns = ["!attachments/**"];
    expect(isTrackableSyncPath("notes/hello.md", opts({ excludePatterns: patterns }))).toBe(true);
  });

  it("should ignore bare lines (without ! prefix) in exclude patterns", () => {
    const patterns = ["attachments/**", "# comment"];
    expect(isTrackableSyncPath("attachments/image.png", opts({ excludePatterns: patterns }))).toBe(true);
  });
});

describe("matchesExcludePattern", () => {
  it("matches glob with **", () => {
    expect(matchesExcludePattern("attachments/img.png", "!attachments/**")).toBe(true);
    expect(matchesExcludePattern("attachments/sub/img.png", "!attachments/**")).toBe(true);
  });

  it("matches glob with *", () => {
    expect(matchesExcludePattern("notes/file.pdf", "!notes/*.pdf")).toBe(true);
    expect(matchesExcludePattern("notes/sub/file.pdf", "!notes/*.pdf")).toBe(false);
  });

  it("returns false for bare lines without !", () => {
    expect(matchesExcludePattern("anything.md", "anything.md")).toBe(false);
    expect(matchesExcludePattern("anything.md", "# comment")).toBe(false);
  });

  it("matches exact file paths", () => {
    expect(matchesExcludePattern("private/secret.md", "!private/secret.md")).toBe(true);
    expect(matchesExcludePattern("other/file.md", "!private/secret.md")).toBe(false);
  });
});
