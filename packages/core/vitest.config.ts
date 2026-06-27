import { defineConfig } from "vitest/config";
import { coverageConfig } from "../../vitest.coverage";

export default defineConfig({
  test: {
    // Ratchet floor — see vitest.coverage.ts. Raise only; never lower.
    coverage: coverageConfig(
      {
        statements: 94,
        branches: 86,
        functions: 96,
        lines: 94,
      },
      // perf/synthetic-store.ts is a test-only store generator: it is used
      // only by perf-budget.test.ts and is never exported from the package,
      // so it does not belong in the shipped-code denominator.
      { exclude: ["src/perf/synthetic-store.ts"] },
    ),
  },
});
