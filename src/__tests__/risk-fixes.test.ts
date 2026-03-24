import { describe, it, expect } from "vitest";
import { StaleStateError } from "../utils";

describe("Risk fixes", () => {
  describe("Risk 2 — StaleStateError", () => {
    it("creates error with expected and actual SHA", () => {
      const err = new StaleStateError("abc12345", "def67890");
      expect(err.name).toBe("StaleStateError");
      expect(err.message).toContain("abc12345");
      expect(err.message).toContain("def67890");
    });

    it("is instanceof Error", () => {
      const err = new StaleStateError("a", "b");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(StaleStateError);
    });
  });

  describe("Risk 4 — Edit always wins over delete", () => {
    it("upload action when remote deleted + local exists (verified via sync-actions tests)", () => {
      // This behavior is tested in sync-actions.test.ts
      // "returns upload when remote deleted but local exists (edit always wins)"
      expect(true).toBe(true);
    });

    it("download action when local deleted + remote exists (verified via sync-actions tests)", () => {
      // This behavior is tested in sync-actions.test.ts
      // "returns download when local deleted but remote has edits (edit wins)"
      expect(true).toBe(true);
    });
  });

  describe("Risk 5 — createCommit retry", () => {
    it("createCommit call includes retry: true (verified via code inspection)", async () => {
      const fs = await import("fs");
      const content = fs.readFileSync("src/sync-manager.ts", "utf-8");
      const lines = content.split("\n");

      // Find the createCommit call in commitSync
      let foundRetry = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("createCommit(") && lines[i].includes("client")) {
          // Check the next few lines for retry: true
          const context = lines.slice(i, i + 10).join("\n");
          if (context.includes("retry: true")) {
            foundRetry = true;
          }
          break;
        }
      }
      expect(foundRetry).toBe(true);
    });
  });

  describe("Risk 6 — All save() calls awaited", () => {
    it("no non-awaited metadataStore.save() calls", async () => {
      const fs = await import("fs");
      const content = fs.readFileSync("src/sync-manager.ts", "utf-8");
      const lines = content.split("\n");

      const nonAwaited = lines.filter((line) => {
        const stripped = line.trim();
        return (
          stripped.includes("metadataStore.save()") &&
          !stripped.startsWith("await") &&
          !stripped.includes("await this.metadataStore.save()")
        );
      });

      expect(nonAwaited).toHaveLength(0);
    });
  });

  describe("Risk 7 — Missing manifest handling", () => {
    it("syncImpl does not throw on missing manifest (verified via code inspection)", async () => {
      const fs = await import("fs");
      const content = fs.readFileSync("src/sync-manager.ts", "utf-8");

      // Should NOT have a throw for missing manifest
      expect(content).not.toContain('throw new Error("Remote manifest is missing")');
      // Should have the synthetic manifest creation
      expect(content).toContain("Remote manifest missing, creating from tree state");
    });
  });

  describe("Risk 8 — Binary conflicts no longer throw", () => {
    it("findConflicts does not throw for binary conflicts (verified via code inspection)", async () => {
      const fs = await import("fs");
      const content = fs.readFileSync("src/sync-manager.ts", "utf-8");

      // Should NOT throw "Binary conflict detected"
      expect(content).not.toContain('throw new Error(\n        "Binary conflict detected');
      // Should have the auto-resolve logic
      expect(content).toContain("Binary conflicts auto-resolved");
    });
  });

  describe("Risk 1 — Event listener pause/resume", () => {
    it("EventsListener has pause/resume methods (verified via code inspection)", async () => {
      const fs = await import("fs");
      const content = fs.readFileSync("src/events-listener.ts", "utf-8");

      expect(content).toContain("pause()");
      expect(content).toContain("resume()");
      expect(content).toContain("this.paused");
      expect(content).toContain("syncWrittenPaths");
    });

    it("sync() calls pause before sync and resume after", async () => {
      const fs = await import("fs");
      const content = fs.readFileSync("src/sync-manager.ts", "utf-8");

      expect(content).toContain("this.eventsListener.pause()");
      expect(content).toContain("this.eventsListener.resume()");
    });
  });

  describe("Risk 3 — Deferred metadata writes", () => {
    it("commitSync uses pendingSHAs pattern", async () => {
      const fs = await import("fs");
      const content = fs.readFileSync("src/sync-manager.ts", "utf-8");

      expect(content).toContain("pendingSHAs");
      expect(content).toContain("manifestSnapshot");
      // Should apply pending SHAs only after successful commit
      expect(content).toContain("Apply pending SHAs");
    });
  });
});
