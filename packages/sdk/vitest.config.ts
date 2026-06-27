import { defineConfig } from "vitest/config";
import { coverageConfig } from "../../vitest.coverage";

export default defineConfig({
  test: {
    // Ratchet floor — see vitest.coverage.ts. Raise only; never lower.
    coverage: coverageConfig({
      statements: 93,
      branches: 86,
      functions: 68,
      lines: 93,
    }),
  },
});
