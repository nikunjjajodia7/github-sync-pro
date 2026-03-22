import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  resolve: {
    alias: {
      src: path.resolve(__dirname, "src"),
      obsidian: path.resolve(__dirname, "mock-obsidian.ts"),
    },
  },
  test: {
    globals: true,
  },
});
