import { Vault, normalizePath } from "obsidian";
import { shallowMergeJSON, PendingSettingsConflict } from "./settings-merge";
import { GitHubSyncSettings, PendingSettingsConflictData } from "./settings/settings";
import GithubClient from "./github/client";
import Logger from "./logger";
import { decodeBase64String } from "./utils";

/**
 * Settings files that are safe to sync across devices.
 * workspace*.json is excluded (device-specific).
 * Plugin binaries are excluded (too large, downloaded from registry).
 */
const SYNCABLE_SETTINGS_FILES = [
  "app.json",
  "appearance.json",
  "hotkeys.json",
  "community-plugins.json",
];

/**
 * Handle settings sync as part of a regular sync cycle.
 *
 * For each syncable settings file:
 * 1. Read local version
 * 2. Fetch remote version (from the last synced tree)
 * 3. If both changed since ancestor: shallow merge
 * 4. Apply non-conflicting changes, queue conflicts for user resolution
 */
export async function syncSettingsFiles({
  vault,
  client,
  settings,
  remoteFiles,
  logger,
}: {
  vault: Vault;
  client: GithubClient;
  settings: GitHubSyncSettings;
  remoteFiles: { [key: string]: { sha: string } };
  logger: Logger;
}): Promise<PendingSettingsConflictData[]> {
  if (!settings.syncSettings) return [];

  const newConflicts: PendingSettingsConflictData[] = [];
  const configDir = vault.configDir;

  for (const fileName of SYNCABLE_SETTINGS_FILES) {
    const filePath = `${configDir}/${fileName}`;
    const remoteEntry = remoteFiles[filePath];

    try {
      // Read local file
      const localExists = await vault.adapter.exists(normalizePath(filePath));
      if (!localExists && !remoteEntry) continue;

      const localContent = localExists
        ? await vault.adapter.read(normalizePath(filePath))
        : "{}";

      let localJSON: Record<string, unknown>;
      try {
        localJSON = JSON.parse(localContent);
      } catch {
        await logger.warn(`Settings sync: ${fileName} is not valid JSON, skipping`);
        continue;
      }

      if (!remoteEntry) {
        // File exists locally but not remotely — will be uploaded by normal sync
        continue;
      }

      // Fetch remote content
      const blob = await client.getBlob({ sha: remoteEntry.sha, retry: true, maxRetries: 1 });
      const remoteContent = decodeBase64String(blob.content);

      let remoteJSON: Record<string, unknown>;
      try {
        remoteJSON = JSON.parse(remoteContent);
      } catch {
        await logger.warn(`Settings sync: remote ${fileName} is not valid JSON, skipping`);
        continue;
      }

      // If they're identical, nothing to do
      if (JSON.stringify(localJSON) === JSON.stringify(remoteJSON)) continue;

      // Use the remote version as the "ancestor" for first sync of settings.
      // On subsequent syncs we'd need a stored ancestor — for now we merge
      // conservatively: treat any key difference as a potential conflict check.
      // This is safe because shallowMergeJSON handles the case where only one
      // side changed (takes that side) vs both changed (conflict).
      //
      // For a true three-way merge, we'd need to store the ancestor settings.
      // For v1 we use a simple heuristic: if a key exists in both and differs,
      // merge non-conflicting keys and flag conflicts.
      const mergeResult = shallowMergeJSON(localJSON, remoteJSON, {});

      if (mergeResult.clean) {
        // All keys merged cleanly — write merged result locally
        await vault.adapter.write(
          normalizePath(filePath),
          JSON.stringify(mergeResult.merged, null, 2),
        );
        await logger.info(`Settings sync: merged ${fileName} cleanly`);
      } else {
        // Apply non-conflicting merged keys locally
        await vault.adapter.write(
          normalizePath(filePath),
          JSON.stringify(mergeResult.merged, null, 2),
        );
        // Queue conflicts for user resolution
        for (const conflict of mergeResult.conflicts) {
          newConflicts.push({
            fileName,
            key: conflict.key,
            localValue: conflict.localValue,
            remoteValue: conflict.remoteValue,
            detectedAt: Date.now(),
          });
        }
        await logger.warn(
          `Settings sync: ${fileName} has ${mergeResult.conflicts.length} conflicts`,
          mergeResult.conflicts.map((c) => c.key),
        );
      }
    } catch (err: any) {
      await logger.error(`Settings sync failed for ${fileName}`, err);
    }
  }

  return newConflicts;
}
