import * as React from "react";
import { ConflictFile, ConflictResolution } from "src/sync-manager";
import diff from "./diff";
import FilesTabBar from "./split-view/files-tab-bar";

type ConflictChoice = "local" | "remote";

const paneStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  border: "1px solid var(--background-modifier-border)",
  borderRadius: "6px",
  backgroundColor: "var(--background-primary)",
};

const lineStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "56px 1fr",
  fontFamily: "var(--font-monospace)",
  fontSize: "var(--font-ui-small)",
  lineHeight: "1.5",
};

const buildChangedLines = (leftText: string, rightText: string) => {
  const chunks = diff(leftText, rightText);
  const leftChanged = new Set<number>();
  const rightChanged = new Set<number>();

  chunks.forEach((chunk) => {
    for (let i = chunk.startLeftLine; i < chunk.endLeftLine; i += 1) {
      leftChanged.add(i);
    }
    for (let i = chunk.startRightLine; i < chunk.endRightLine; i += 1) {
      rightChanged.add(i);
    }
  });

  return { leftChanged, rightChanged };
};

const renderLines = (
  content: string,
  changedLines: Set<number>,
  highlightColor: string,
) => {
  const lines = content.split("\n");
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    const changed = changedLines.has(lineNumber);
    return (
      <div
        key={lineNumber}
        style={{
          ...lineStyle,
          backgroundColor: changed ? highlightColor : "transparent",
        }}
      >
        <div
          style={{
            color: "var(--text-faint)",
            textAlign: "right",
            paddingRight: "10px",
            userSelect: "none",
          }}
        >
          {lineNumber}
        </div>
        <div
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            paddingRight: "8px",
          }}
        >
          {line === "" ? "\u00a0" : line}
        </div>
      </div>
    );
  });
};

const SimpleConflictResolutionView = ({
  initialFiles,
  onResolveAllConflicts,
}: {
  initialFiles: ConflictFile[];
  onResolveAllConflicts: (resolutions: ConflictResolution[]) => void;
}) => {
  const [currentFileIndex, setCurrentFileIndex] = React.useState(0);
  const [choices, setChoices] = React.useState<Record<string, ConflictChoice>>(
    {},
  );
  const [isApplying, setIsApplying] = React.useState(false);

  const currentFile = initialFiles.at(currentFileIndex);
  const allChosen = initialFiles.every((file) => choices[file.filePath]);

  const choose = (filePath: string, choice: ConflictChoice) => {
    setChoices((prev) => ({ ...prev, [filePath]: choice }));
  };

  const applyChoices = () => {
    const unresolved = initialFiles.find((file) => !choices[file.filePath]);
    if (unresolved) {
      return;
    }

    setIsApplying(true);
    try {
      const resolutions = initialFiles.map((file) => ({
        filePath: file.filePath,
        strategy: choices[file.filePath],
      }));
      onResolveAllConflicts(resolutions);
    } catch (err) {
      console.error("Failed applying conflict choices", err);
      setIsApplying(false);
    }
  };

  if (!currentFile) {
    return (
      <div
        style={{
          padding: "var(--size-4-8)",
          color: "var(--text-muted)",
          textAlign: "center",
        }}
      >
        {isApplying ? "Applying your conflict choices..." : "No conflicts to resolve"}
      </div>
    );
  }

  const isBinaryPreview =
    currentFile.remoteContent === "" && currentFile.localContent === "";
  const { leftChanged, rightChanged } = buildChangedLines(
    currentFile.remoteContent || "",
    currentFile.localContent || "",
  );

  const selectedChoice = choices[currentFile.filePath];
  const decidedCount = Object.keys(choices).length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
      }}
    >
      {isApplying ? (
        <div
          style={{
            padding: "var(--size-4-8)",
            color: "var(--text-muted)",
            textAlign: "center",
          }}
        >
          Applying your conflict choices...
        </div>
      ) : (
        <>
        <FilesTabBar
          files={initialFiles.map((f) => f.filePath)}
          currentFile={currentFile.filePath}
          setCurrentFileIndex={setCurrentFileIndex}
        />

        <div style={{ padding: "var(--size-4-4) var(--size-4-6)" }}>
          <div style={{ color: "var(--text-muted)", marginBottom: "8px" }}>
            Choose one version per file to continue sync ({decidedCount}/
            {initialFiles.length} selected).
          </div>
          <div style={{ display: "flex", gap: "10px", marginBottom: "10px" }}>
            <button
              style={{
                backgroundColor:
                  selectedChoice === "remote"
                    ? "var(--interactive-accent)"
                    : undefined,
                color:
                  selectedChoice === "remote"
                    ? "var(--text-on-accent)"
                    : undefined,
              }}
              onClick={() => choose(currentFile.filePath, "remote")}
            >
              Use Remote
            </button>
            <button
              style={{
                backgroundColor:
                  selectedChoice === "local"
                    ? "var(--interactive-accent)"
                    : undefined,
                color:
                  selectedChoice === "local"
                    ? "var(--text-on-accent)"
                    : undefined,
              }}
              onClick={() => choose(currentFile.filePath, "local")}
            >
              Use Local
            </button>
            <div style={{ flex: 1 }} />
            <button
              disabled={!allChosen}
              style={{
                backgroundColor: allChosen
                  ? "var(--interactive-accent)"
                  : undefined,
                color: allChosen ? "var(--text-on-accent)" : undefined,
              }}
              onClick={applyChoices}
            >
              Apply choices
            </button>
          </div>

          {isBinaryPreview ? (
            <div
              style={{
                color: "var(--text-muted)",
                border: "1px solid var(--background-modifier-border)",
                borderRadius: "6px",
                padding: "16px",
              }}
            >
              Binary file preview is unavailable. Choose whether to keep Remote
              or Local for this file.
            </div>
          ) : (
            <div style={{ display: "flex", gap: "10px", height: "62vh" }}>
              <div style={paneStyle}>
                <div
                  style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    padding: "6px 8px",
                    borderBottom: "1px solid var(--background-modifier-border)",
                    backgroundColor: "var(--background-secondary)",
                    fontWeight: 600,
                  }}
                >
                  Remote
                </div>
                {renderLines(
                  currentFile.remoteContent || "",
                  leftChanged,
                  "rgba(var(--color-red-rgb), 0.12)",
                )}
              </div>
              <div style={paneStyle}>
                <div
                  style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    padding: "6px 8px",
                    borderBottom: "1px solid var(--background-modifier-border)",
                    backgroundColor: "var(--background-secondary)",
                    fontWeight: 600,
                  }}
                >
                  Local
                </div>
                {renderLines(
                  currentFile.localContent || "",
                  rightChanged,
                  "rgba(var(--color-green-rgb), 0.12)",
                )}
              </div>
            </div>
          )}
        </div>
        </>
      )}
    </div>
  );
};

export default SimpleConflictResolutionView;
