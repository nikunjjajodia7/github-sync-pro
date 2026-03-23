import { useState, useEffect, useCallback } from "react";
import { Notice } from "obsidian";
import { FileCommit } from "src/github/client";
import { decodeBase64String } from "src/utils";
import { usePlugin } from "../hooks";

interface VersionHistoryViewProps {
  filePath: string;
}

interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number;
}

function computeSimpleDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Simple LCS-based diff for display purposes
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0, ni = 0;
  let lineNum = 1;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi >= oldLines.length) {
      result.push({ type: "added", content: newLines[ni], lineNumber: lineNum++ });
      ni++;
    } else if (ni >= newLines.length) {
      result.push({ type: "removed", content: oldLines[oi], lineNumber: lineNum++ });
      oi++;
    } else if (oldLines[oi] === newLines[ni]) {
      result.push({ type: "unchanged", content: newLines[ni], lineNumber: lineNum++ });
      oi++;
      ni++;
    } else {
      result.push({ type: "removed", content: oldLines[oi], lineNumber: lineNum++ });
      result.push({ type: "added", content: newLines[ni], lineNumber: lineNum++ });
      oi++;
      ni++;
    }
  }
  return result;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateMessage(msg: string, maxLen: number = 60): string {
  const firstLine = msg.split("\n")[0];
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "..." : firstLine;
}

export default function VersionHistoryView({ filePath }: VersionHistoryViewProps) {
  const plugin = usePlugin();
  const [commits, setCommits] = useState<FileCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [compareCommit, setCompareCommit] = useState<string | null>(null);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    loadCommits();
  }, [filePath]);

  async function loadCommits() {
    if (!plugin) return;
    setLoading(true);
    setError(null);
    try {
      const rateLimit = plugin.syncManager.getRateLimit();
      if (rateLimit.remaining < 10) {
        setError(`Rate limit low (${rateLimit.remaining} remaining). Try again after ${rateLimit.resetAt.toLocaleTimeString()}.`);
        setLoading(false);
        return;
      }
      const result = await plugin.syncManager.getClient().getFileCommits({
        path: filePath,
        retry: true,
      });
      setCommits(result);
      if (result.length === 0) {
        setError("No history found. This file may not have been synced yet.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to load history");
    }
    setLoading(false);
  }

  const loadDiff = useCallback(async (olderSha: string, newerSha: string) => {
    if (!plugin) return;
    setDiffLoading(true);
    try {
      const client = plugin.syncManager.getClient();
      const [olderContent, newerContent] = await Promise.all([
        client.getFileAtCommit({ path: filePath, commitSha: olderSha, retry: true }),
        client.getFileAtCommit({ path: filePath, commitSha: newerSha, retry: true }),
      ]);

      const oldText = olderContent ? decodeBase64String(olderContent) : "";
      const newText = newerContent ? decodeBase64String(newerContent) : "";
      setDiffLines(computeSimpleDiff(oldText, newText));
    } catch (err: any) {
      new Notice(`Failed to load diff: ${err.message}`);
    }
    setDiffLoading(false);
  }, [plugin, filePath]);

  function handleSelectCommit(sha: string) {
    if (!selectedCommit) {
      setSelectedCommit(sha);
      setCompareCommit(null);
      setDiffLines(null);
    } else if (selectedCommit === sha) {
      // Deselect
      setSelectedCommit(null);
      setCompareCommit(null);
      setDiffLines(null);
    } else {
      // Second selection — show diff
      setCompareCommit(sha);
      // Figure out which is older
      const idx1 = commits.findIndex(c => c.sha === selectedCommit);
      const idx2 = commits.findIndex(c => c.sha === sha);
      // commits are newest-first, so higher index = older
      const olderSha = idx1 > idx2 ? selectedCommit : sha;
      const newerSha = idx1 > idx2 ? sha : selectedCommit;
      loadDiff(olderSha, newerSha);
    }
  }

  async function handleRestore(sha: string) {
    if (!plugin) return;
    if (plugin.syncManager.isSyncing()) {
      new Notice("Cannot restore while sync is in progress. Wait for sync to complete.");
      return;
    }
    setRestoring(true);
    try {
      const client = plugin.syncManager.getClient();
      const content = await client.getFileAtCommit({
        path: filePath,
        commitSha: sha,
        retry: true,
      });
      if (content === null) {
        new Notice("File not found at this version.");
        setRestoring(false);
        return;
      }
      const decoded = decodeBase64String(content);
      await plugin.app.vault.adapter.write(filePath, decoded);
      // Mark file as dirty in metadata so next sync uploads the restored version
      // instead of silently overwriting it with the remote version
      plugin.syncManager.markFileDirty(filePath);
      new Notice(`Restored to version from ${formatDate(commits.find(c => c.sha === sha)?.date || "")}`);
    } catch (err: any) {
      new Notice(`Restore failed: ${err.message}`);
    }
    setRestoring(false);
  }

  if (loading) {
    return <div style={{ padding: 16 }}>Loading history for {filePath}...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ color: "var(--text-error)" }}>{error}</p>
        <button onClick={loadCommits}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, height: "100%", overflow: "auto" }}>
      <h4 style={{ marginTop: 0 }}>History: {filePath}</h4>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {commits.length} version{commits.length !== 1 ? "s" : ""} found.
        Select two versions to compare, or restore any version.
      </p>

      <div style={{ display: "flex", gap: 16, height: "calc(100% - 80px)" }}>
        {/* Timeline */}
        <div style={{
          width: 320,
          minWidth: 280,
          overflowY: "auto",
          borderRight: "1px solid var(--background-modifier-border)",
          paddingRight: 12,
        }}>
          {commits.map((commit, i) => {
            const isSelected = selectedCommit === commit.sha || compareCommit === commit.sha;
            return (
              <div
                key={commit.sha}
                onClick={() => handleSelectCommit(commit.sha)}
                style={{
                  padding: "8px 10px",
                  marginBottom: 4,
                  borderRadius: 6,
                  cursor: "pointer",
                  background: isSelected
                    ? "var(--interactive-accent)"
                    : "var(--background-secondary)",
                  color: isSelected ? "var(--text-on-accent)" : "inherit",
                  border: isSelected
                    ? "2px solid var(--interactive-accent)"
                    : "1px solid var(--background-modifier-border)",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {truncateMessage(commit.message)}
                </div>
                <div style={{
                  fontSize: 11,
                  marginTop: 4,
                  opacity: 0.7,
                }}>
                  {formatDate(commit.date)} — {commit.authorName}
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRestore(commit.sha);
                    }}
                    disabled={restoring}
                    style={{ fontSize: 11, padding: "2px 8px" }}
                  >
                    {restoring ? "..." : "Restore"}
                  </button>
                  <span style={{ fontSize: 10, opacity: 0.5, alignSelf: "center" }}>
                    {commit.sha.slice(0, 7)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Diff panel */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {diffLoading && <p>Loading diff...</p>}
          {!diffLoading && !diffLines && selectedCommit && !compareCommit && (
            <p style={{ color: "var(--text-muted)" }}>
              Select a second version to compare.
            </p>
          )}
          {!diffLoading && !diffLines && !selectedCommit && (
            <p style={{ color: "var(--text-muted)" }}>
              Select a version from the timeline to get started.
            </p>
          )}
          {diffLines && (
            <div style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}>
              {diffLines.map((line, i) => (
                <div
                  key={i}
                  style={{
                    padding: "1px 8px",
                    background:
                      line.type === "added"
                        ? "var(--background-modifier-success)"
                        : line.type === "removed"
                        ? "var(--background-modifier-error)"
                        : "transparent",
                    opacity: line.type === "unchanged" ? 0.7 : 1,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  <span style={{ opacity: 0.4, marginRight: 8, userSelect: "none" }}>
                    {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                  </span>
                  {line.content}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
