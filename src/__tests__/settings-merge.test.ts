import { describe, it, expect } from "vitest";
import { shallowMergeJSON } from "../settings-merge";

describe("shallowMergeJSON", () => {
  it("merges non-conflicting changes from both sides", () => {
    const ancestor = { a: 1, b: 2, c: 3 };
    const local = { a: 10, b: 2, c: 3 }; // changed a
    const remote = { a: 1, b: 2, c: 30 }; // changed c

    const result = shallowMergeJSON(local, remote, ancestor);
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual({ a: 10, b: 2, c: 30 });
    expect(result.conflicts).toHaveLength(0);
  });

  it("detects conflict when both sides change same key differently", () => {
    const ancestor = { theme: "light" };
    const local = { theme: "dark" };
    const remote = { theme: "solarized" };

    const result = shallowMergeJSON(local, remote, ancestor);
    expect(result.clean).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].key).toBe("theme");
    expect(result.conflicts[0].localValue).toBe("dark");
    expect(result.conflicts[0].remoteValue).toBe("solarized");
  });

  it("no conflict when both sides change to same value", () => {
    const ancestor = { theme: "light" };
    const local = { theme: "dark" };
    const remote = { theme: "dark" };

    const result = shallowMergeJSON(local, remote, ancestor);
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual({ theme: "dark" });
  });

  it("handles key added on one side only", () => {
    const ancestor = { a: 1 };
    const local = { a: 1, b: 2 }; // added b
    const remote = { a: 1 }; // unchanged

    const result = shallowMergeJSON(local, remote, ancestor);
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual({ a: 1, b: 2 });
  });

  it("handles key added on both sides (same value)", () => {
    const ancestor = {};
    const local = { newKey: "hello" };
    const remote = { newKey: "hello" };

    const result = shallowMergeJSON(local, remote, ancestor);
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual({ newKey: "hello" });
  });

  it("handles key added on both sides (different values) as conflict", () => {
    const ancestor = {};
    const local = { newKey: "local" };
    const remote = { newKey: "remote" };

    const result = shallowMergeJSON(local, remote, ancestor);
    expect(result.clean).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].key).toBe("newKey");
  });

  it("handles key deleted on one side", () => {
    const ancestor = { a: 1, b: 2 };
    const local = { a: 1 }; // deleted b
    const remote = { a: 1, b: 2 }; // unchanged

    const result = shallowMergeJSON(local, remote, ancestor);
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual({ a: 1 });
    expect("b" in result.merged).toBe(false);
  });

  it("treats nested objects as opaque values", () => {
    const ancestor = { config: { nested: true, value: 1 } };
    const local = { config: { nested: true, value: 2 } }; // changed nested value
    const remote = { config: { nested: true, value: 3 } }; // changed nested value differently

    const result = shallowMergeJSON(local, remote, ancestor);
    expect(result.clean).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].key).toBe("config");
  });

  it("no changes produces clean merge with ancestor values", () => {
    const data = { a: 1, b: "hello" };
    const result = shallowMergeJSON(data, data, data);
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual(data);
  });

  it("handles empty objects", () => {
    const result = shallowMergeJSON({}, {}, {});
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual({});
  });
});
