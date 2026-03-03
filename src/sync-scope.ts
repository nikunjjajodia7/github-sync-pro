import { GitHubSyncSettings } from "./settings/settings";

type ScopeOptions = Pick<GitHubSyncSettings, "syncConfigDir" | "syncScopeMode"> & {
  configDir: string;
  manifestPath: string;
  logPath: string;
  includeManifest?: boolean;
};

const NOTES_FIRST_EXTENSIONS = new Set([
  "md",
  "txt",
  "csv",
  "json",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "pdf",
]);

const EXCLUDED_EXTENSIONS = new Set([
  "mp3",
  "m4a",
  "wav",
  "webm",
  "m4b",
  "aac",
  "ogg",
  "flac",
  "aiff",
  "caf",
  "mp4",
]);

const EXCLUDED_PATH_SEGMENTS = [
  "node_modules",
  ".npm-cache",
  ".pnpm-store",
  ".yarn",
  ".cache",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vite",
];

function hasExcludedSegment(filePath: string): boolean {
  const segments = filePath.split("/");
  return segments.some((segment) => EXCLUDED_PATH_SEGMENTS.contains(segment));
}

function getExtension(filePath: string): string {
  const filename = filePath.split("/").last() ?? "";
  if (!filename.contains(".")) {
    return "";
  }
  return filename.split(".").last()?.toLowerCase() ?? "";
}

export function isTrackableSyncPath(
  filePath: string,
  {
    configDir,
    manifestPath,
    logPath,
    syncConfigDir,
    syncScopeMode,
    includeManifest = true,
  }: ScopeOptions,
): boolean {
  if (filePath === manifestPath) {
    return includeManifest;
  }
  if (
    filePath === `${configDir}/workspace.json` ||
    filePath === `${configDir}/workspace-mobile.json` ||
    filePath === logPath ||
    filePath.endsWith(".DS_Store") ||
    filePath.endsWith("Thumbs.db")
  ) {
    return false;
  }
  if (!syncConfigDir && filePath.startsWith(configDir)) {
    return false;
  }
  if (filePath.endsWith(".log")) {
    return false;
  }
  if (hasExcludedSegment(filePath)) {
    return false;
  }
  if (EXCLUDED_EXTENSIONS.has(getExtension(filePath))) {
    return false;
  }
  if (syncScopeMode === "broad") {
    return true;
  }

  return NOTES_FIRST_EXTENSIONS.has(getExtension(filePath));
}
