import { merge } from "node-diff3";

export interface MergeResult {
  /** Whether the merge was clean (no overlapping changes) */
  clean: boolean;
  /** The merged content (only valid if clean === true) */
  mergedContent: string | null;
}

/**
 * Attempt a three-way merge of text content.
 *
 * @param localContent - The user's local version
 * @param remoteContent - The version from GitHub
 * @param ancestorContent - The common ancestor version
 * @returns MergeResult indicating whether the merge was clean
 */
export function tryThreeWayMerge(
  localContent: string,
  remoteContent: string,
  ancestorContent: string,
): MergeResult {
  const localLines = localContent.split("\n");
  const remoteLines = remoteContent.split("\n");
  const ancestorLines = ancestorContent.split("\n");

  const result = merge(localLines, ancestorLines, remoteLines);

  if (!result.conflict) {
    // Clean merge — no overlapping changes
    const mergedLines: string[] = [];
    for (const block of result.result) {
      if (typeof block === "string") {
        mergedLines.push(block);
      } else if (Array.isArray(block)) {
        mergedLines.push(...block);
      }
    }
    return {
      clean: true,
      mergedContent: mergedLines.join("\n"),
    };
  }

  // Conflict detected — overlapping changes exist
  return {
    clean: false,
    mergedContent: null,
  };
}
