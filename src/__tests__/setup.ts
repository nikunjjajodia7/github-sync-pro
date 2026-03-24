/**
 * Test setup — polyfills for Obsidian-specific APIs.
 *
 * Obsidian adds these to the global prototypes:
 * - Array.prototype.contains (alias for .includes)
 * - String.prototype.contains (alias for .includes)
 * - Array.prototype.last (returns last element)
 * - String.prototype.last (returns last char... or used on split result)
 */

// @ts-expect-error Obsidian polyfill
Array.prototype.contains = function (item: any) {
  return this.includes(item);
};

// @ts-expect-error Obsidian polyfill
String.prototype.contains = function (s: string) {
  return this.includes(s);
};

// @ts-expect-error Obsidian polyfill
Array.prototype.last = function () {
  return this.length > 0 ? this[this.length - 1] : undefined;
};
