import { defineConfig } from "vitest/config";
import { coverageConfig } from "../../vitest.coverage";

export default defineConfig({
  test: {
    // Ratchet floor — see vitest.coverage.ts. Raise only; never lower.
    // Re-derived on the move to Vitest 4 from its measurement (statements
    // 94.55, branches 88.57, functions 96.00, lines 96.32). Under Vitest 3, which
    // counted differently, the floors were 94 / 86 / 96 / 94.
    coverage: coverageConfig(
      {
        statements: 93,
        branches: 87,
        functions: 95,
        lines: 95,
      },
      // perf/synthetic-store.ts is a test-only store generator: it is used
      // only by perf-budget.test.ts and is never exported from the package,
      // so it does not belong in the shipped-code denominator.
      { exclude: ["src/perf/synthetic-store.ts"] },
    ),
  },
});
