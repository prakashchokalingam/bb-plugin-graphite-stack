import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname) },
  },
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    setupFiles: ["tests/setup-storage.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Integration suites spawn many real git and gt processes. Bound the
    // parallel workers and allow time on a busy machine.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 2,
    minWorkers: 1,
  },
});
