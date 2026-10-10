import { defineConfig } from "vitest/config";
import { coverageConfig } from "../../vitest.coverage";

export default defineConfig({
  test: {
    // Ratchet floor — see vitest.coverage.ts. Raise only; never lower.
    // Re-derived on the move to Vitest 4 from its measurement (statements
    // 87.57, branches 79.70, functions 84.32, lines 88.49). Under Vitest 3, which
    // counted differently, the floors were 85 / 80 / 84 / 85.
    coverage: coverageConfig({
      statements: 86,
      branches: 78,
      functions: 83,
      lines: 87,
    }),
  },
});
