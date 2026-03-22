declare module "node-diff3" {
  interface MergeResult {
    conflict: boolean;
    result: (string | string[])[];
  }

  export function merge(
    a: string[],
    o: string[],
    b: string[],
    options?: { stringSeparator?: string | RegExp }
  ): MergeResult;

  export function diff3Merge(
    a: string[],
    o: string[],
    b: string[],
    options?: { excludeFalseConflicts?: boolean }
  ): Array<{
    ok?: string[];
    conflict?: { a: string[]; aIndex: number; o: string[]; oIndex: number; b: string[]; bIndex: number };
  }>;
}
