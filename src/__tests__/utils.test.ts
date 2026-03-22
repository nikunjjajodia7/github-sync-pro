import { describe, it, expect, vi } from "vitest";
import { retryUntil, hasTextExtension, decodeBase64String } from "../utils";

describe("retryUntil", () => {
  it("returns immediately when condition is met on first try", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await retryUntil(fn, (r) => r === 42, 5, 1, 1);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until condition is met", async () => {
    let call = 0;
    const fn = vi.fn().mockImplementation(async () => {
      call++;
      return call;
    });
    const result = await retryUntil(fn, (r) => r === 3, 5, 1, 1);
    expect(result).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops after maxRetries even if condition not met", async () => {
    const fn = vi.fn().mockResolvedValue(0);
    const result = await retryUntil(fn, (r) => r === 999, 3, 1, 1);
    expect(result).toBe(0);
    // 1 initial call + 3 retries = 4 total
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("with 0 retries, calls fn once and returns", async () => {
    const fn = vi.fn().mockResolvedValue(0);
    const result = await retryUntil(fn, (r) => r === 999, 0, 1, 1);
    expect(result).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("hasTextExtension", () => {
  it.each([".md", ".json", ".css", ".txt", ".csv"])("returns true for %s", (ext) => {
    expect(hasTextExtension(`file${ext}`)).toBe(true);
  });

  it.each([".png", ".pdf", ".zip"])("returns false for %s", (ext) => {
    expect(hasTextExtension(`file${ext}`)).toBe(false);
  });
});

describe("decodeBase64String", () => {
  it("decodes a base64 encoded string", () => {
    // "Hello, World!" in base64
    const encoded = btoa("Hello, World!");
    expect(decodeBase64String(encoded)).toBe("Hello, World!");
  });
});
