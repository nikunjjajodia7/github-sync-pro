/**
 * Shallow field-level JSON merge for Obsidian settings files.
 *
 * Merges at the top-level keys only. Nested objects are compared as
 * opaque values — if both sides changed the same top-level key,
 * it's flagged as a conflict.
 */

export interface SettingsMergeResult {
  /** The merged JSON object (includes all non-conflicting keys) */
  merged: Record<string, unknown>;
  /** Keys where both local and remote changed the same top-level key */
  conflicts: SettingsConflict[];
  /** Whether the merge was completely clean (no conflicts) */
  clean: boolean;
}

export interface SettingsConflict {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
}

export interface PendingSettingsConflict extends SettingsConflict {
  fileName: string;
  detectedAt: number;
}

/**
 * Perform a shallow merge of two JSON objects against a common ancestor.
 *
 * - Keys changed only on one side: take that side's value
 * - Keys changed on both sides to the same value: take either (identical)
 * - Keys changed on both sides to different values: conflict
 * - Keys added on one side: include them
 * - Keys deleted on one side (but not the other): delete them
 */
export function shallowMergeJSON(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  ancestor: Record<string, unknown>,
): SettingsMergeResult {
  const merged: Record<string, unknown> = {};
  const conflicts: SettingsConflict[] = [];

  // Collect all keys across all three versions
  const allKeys = new Set([
    ...Object.keys(ancestor),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);

  for (const key of allKeys) {
    const ancestorVal = ancestor[key];
    const localVal = local[key];
    const remoteVal = remote[key];

    const localChanged = !deepEqual(ancestorVal, localVal);
    const remoteChanged = !deepEqual(ancestorVal, remoteVal);

    if (!localChanged && !remoteChanged) {
      // Neither side changed — keep ancestor value
      if (key in ancestor) {
        merged[key] = ancestorVal;
      }
    } else if (localChanged && !remoteChanged) {
      // Only local changed — take local
      if (key in local) {
        merged[key] = localVal;
      }
      // If key was deleted locally (not in local), omit it
    } else if (!localChanged && remoteChanged) {
      // Only remote changed — take remote
      if (key in remote) {
        merged[key] = remoteVal;
      }
    } else {
      // Both changed
      if (deepEqual(localVal, remoteVal)) {
        // Changed to the same value — no conflict
        if (key in local) {
          merged[key] = localVal;
        }
      } else {
        // Genuine conflict — both changed to different values
        conflicts.push({ key, localValue: localVal, remoteValue: remoteVal });
        // Keep local value in merged for now (user resolves later)
        if (key in local) {
          merged[key] = localVal;
        } else if (key in remote) {
          merged[key] = remoteVal;
        }
      }
    }
  }

  return {
    merged,
    conflicts,
    clean: conflicts.length === 0,
  };
}

/**
 * Simple deep equality check for JSON-serializable values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined && b === undefined) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;

  // Compare as JSON strings for objects/arrays (opaque comparison at this level)
  return JSON.stringify(a) === JSON.stringify(b);
}
