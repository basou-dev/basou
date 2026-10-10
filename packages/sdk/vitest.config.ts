import { defineConfig } from "vitest/config";
import { coverageConfig } from "../../vitest.coverage";

export default defineConfig({
  test: {
    // Ratchet floor — see vitest.coverage.ts. Raise only; never lower.
    // Re-derived on the move to Vitest 4 from its measurement (statements
    // 91.80, branches 84.90, functions 79.59, lines 92.59). Under Vitest 3, which
    // counted differently, the floors were 93 / 86 / 68 / 93.
    coverage: coverageConfig({
      statements: 90,
      branches: 83,
      functions: 78,
      lines: 91,
    }),
  },
});
