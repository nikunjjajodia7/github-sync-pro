import { describe, it, expect } from "vitest";
import { tryThreeWayMerge } from "../auto-merge";

describe("tryThreeWayMerge", () => {
  it("cleanly merges non-overlapping changes", () => {
    const ancestor = "line1\nline2\nline3";
    const local = "line1-changed\nline2\nline3"; // changed line 1
    const remote = "line1\nline2\nline3-changed"; // changed line 3

    const result = tryThreeWayMerge(local, remote, ancestor);
    expect(result.clean).toBe(true);
    expect(result.mergedContent).toBe("line1-changed\nline2\nline3-changed");
  });

  it("detects overlapping changes as conflict", () => {
    const ancestor = "line1\nline2\nline3";
    const local = "line1-local\nline2\nline3";
    const remote = "line1-remote\nline2\nline3";

    const result = tryThreeWayMerge(local, remote, ancestor);
    expect(result.clean).toBe(false);
    expect(result.mergedContent).toBeNull();
  });

  it("handles identical changes on both sides (no conflict)", () => {
    const ancestor = "line1\nline2\nline3";
    const local = "line1-same\nline2\nline3";
    const remote = "line1-same\nline2\nline3";

    const result = tryThreeWayMerge(local, remote, ancestor);
    expect(result.clean).toBe(true);
    expect(result.mergedContent).toBe("line1-same\nline2\nline3");
  });

  it("handles additions on different sides", () => {
    const ancestor = "line1\nline2";
    const local = "line0-new\nline1\nline2"; // added at beginning
    const remote = "line1\nline2\nline3-new"; // added at end

    const result = tryThreeWayMerge(local, remote, ancestor);
    expect(result.clean).toBe(true);
    expect(result.mergedContent).toBe("line0-new\nline1\nline2\nline3-new");
  });

  it("handles no changes", () => {
    const content = "same\ncontent\neverywhere";
    const result = tryThreeWayMerge(content, content, content);
    expect(result.clean).toBe(true);
    expect(result.mergedContent).toBe(content);
  });
});
