import { describe, it, expect } from "vitest";
import { isTrackableSyncPath } from "../sync-scope";

const defaultOpts = {
  configDir: ".obsidian",
  manifestPath: ".obsidian/github-sync-metadata.json",
  logPath: ".obsidian/github-sync-pro.log",
  syncConfigDir: false,
  syncScopeMode: "notes-first" as const,
  includeManifest: false,
};

function opts(overrides: Partial<typeof defaultOpts> = {}) {
  return { ...defaultOpts, ...overrides };
}

describe("isTrackableSyncPath", () => {
  // Always-excluded files
  it("excludes workspace.json", () => {
    expect(isTrackableSyncPath(".obsidian/workspace.json", opts())).toBe(false);
  });

  it("excludes workspace-mobile.json", () => {
    expect(isTrackableSyncPath(".obsidian/workspace-mobile.json", opts())).toBe(false);
  });

  it("excludes log file", () => {
    expect(isTrackableSyncPath(".obsidian/github-sync-pro.log", opts())).toBe(false);
  });

  it("excludes .DS_Store", () => {
    expect(isTrackableSyncPath("notes/.DS_Store", opts())).toBe(false);
  });

  it("excludes Thumbs.db", () => {
    expect(isTrackableSyncPath("notes/Thumbs.db", opts())).toBe(false);
  });

  // Directory exclusions
  it("excludes node_modules paths", () => {
    expect(isTrackableSyncPath("node_modules/foo/bar.js", opts())).toBe(false);
  });

  it("excludes .git paths", () => {
    expect(isTrackableSyncPath(".git/config", opts())).toBe(false);
  });

  it("excludes dist paths", () => {
    expect(isTrackableSyncPath("dist/main.js", opts())).toBe(false);
  });

  // Config dir behavior
  it("excludes config dir files when syncConfigDir is false", () => {
    expect(isTrackableSyncPath(".obsidian/plugins/foo/data.json", opts())).toBe(false);
  });

  it("includes config dir files when syncConfigDir is true", () => {
    expect(
      isTrackableSyncPath(".obsidian/plugins/foo/data.json", opts({ syncConfigDir: true })),
    ).toBe(true);
  });

  // Manifest behavior
  it("excludes manifest when includeManifest is false", () => {
    expect(
      isTrackableSyncPath(".obsidian/github-sync-metadata.json", opts()),
    ).toBe(false);
  });

  it("includes manifest when includeManifest is true", () => {
    expect(
      isTrackableSyncPath(
        ".obsidian/github-sync-metadata.json",
        opts({ includeManifest: true }),
      ),
    ).toBe(true);
  });

  // notes-first mode
  it("includes .md files in notes-first mode", () => {
    expect(isTrackableSyncPath("notes/my-note.md", opts())).toBe(true);
  });

  it("includes .txt files in notes-first mode", () => {
    expect(isTrackableSyncPath("notes/readme.txt", opts())).toBe(true);
  });

  it("includes .json files in notes-first mode", () => {
    expect(isTrackableSyncPath("data/config.json", opts())).toBe(true);
  });

  it("includes .png files in notes-first mode", () => {
    expect(isTrackableSyncPath("attachments/image.png", opts())).toBe(true);
  });

  it("includes .pdf files in notes-first mode", () => {
    expect(isTrackableSyncPath("papers/doc.pdf", opts())).toBe(true);
  });

  it("excludes .ts files in notes-first mode", () => {
    expect(isTrackableSyncPath("src/main.ts", opts())).toBe(false);
  });

  it("excludes .js files in notes-first mode", () => {
    expect(isTrackableSyncPath("scripts/build.js", opts())).toBe(false);
  });

  it("excludes .cjs files in notes-first mode", () => {
    expect(isTrackableSyncPath("config.cjs", opts())).toBe(false);
  });

  // broad mode
  it("includes .ts files in broad mode", () => {
    expect(isTrackableSyncPath("src/main.ts", opts({ syncScopeMode: "broad" }))).toBe(true);
  });

  it("includes .js files in broad mode", () => {
    expect(isTrackableSyncPath("scripts/build.js", opts({ syncScopeMode: "broad" }))).toBe(true);
  });

  it("still excludes .DS_Store in broad mode", () => {
    expect(isTrackableSyncPath(".DS_Store", opts({ syncScopeMode: "broad" }))).toBe(false);
  });

  it("still excludes node_modules in broad mode", () => {
    expect(
      isTrackableSyncPath("node_modules/foo.js", opts({ syncScopeMode: "broad" })),
    ).toBe(false);
  });
});
