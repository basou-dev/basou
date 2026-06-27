import { defineConfig } from "vitest/config";
import { coverageConfig } from "../../vitest.coverage";

export default defineConfig({
  test: {
    // Ratchet floor — see vitest.coverage.ts. Raise only; never lower.
    coverage: coverageConfig({
      statements: 85,
      branches: 80,
      functions: 84,
      lines: 85,
    }),
  },
});
