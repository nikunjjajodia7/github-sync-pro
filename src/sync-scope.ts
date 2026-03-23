import { GitHubSyncSettings } from "./settings/settings";

type ScopeOptions = Pick<GitHubSyncSettings, "syncConfigDir" | "syncScopeMode"> & {
  configDir: string;
  manifestPath: string;
  logPath: string;
  includeManifest?: boolean;
  excludePatterns?: string[];
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

/**
 * Match a file path against a simple glob-like exclude pattern.
 * Supports: `*` (any segment chars), `**` (any path), `!` prefix (exclude marker).
 * Pattern without `!` prefix is treated as a no-op (comment-like).
 */
export function matchesExcludePattern(filePath: string, pattern: string): boolean {
  // Strip the `!` prefix — that's just the exclude marker
  let p = pattern.trim();
  if (!p.startsWith("!")) return false; // bare lines are no-ops
  p = p.slice(1);
  if (p === "") return false;

  // Convert glob to regex
  const regexStr = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars (except * and ?)
    .replace(/\*\*/g, "{{GLOBSTAR}}") // placeholder for **
    .replace(/\*/g, "[^/]*") // * matches within one segment
    .replace(/\?/g, "[^/]") // ? matches one char
    .replace(/\{\{GLOBSTAR\}\}/g, ".*"); // ** matches across segments

  try {
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(filePath);
  } catch {
    // Malformed pattern — treat as non-matching rather than crashing
    return false;
  }
}

/**
 * Check if a file path matches any user-defined exclude pattern.
 */
function isExcludedByUserPatterns(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchesExcludePattern(filePath, pattern)) {
      return true;
    }
  }
  return false;
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
    excludePatterns = [],
  }: ScopeOptions,
): boolean {
  if (filePath === manifestPath) {
    return includeManifest;
  }
  // .gitkeep files are always trackable — they're used for empty folder sync
  if (filePath.endsWith("/.gitkeep") || filePath === ".gitkeep") {
    return true;
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
  // Check user-defined exclude patterns
  if (excludePatterns.length > 0 && isExcludedByUserPatterns(filePath, excludePatterns)) {
    return false;
  }
  if (syncScopeMode === "broad") {
    return true;
  }

  return NOTES_FIRST_EXTENSIONS.has(getExtension(filePath));
}
