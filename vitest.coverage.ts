interface CoverageThresholds {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

/**
 * Shared coverage policy for every package's `test:coverage` run.
 *
 * One place defines HOW coverage is measured (v8, whole-src denominator,
 * which files count); each package's vitest.config.ts passes only its own
 * ratchet floor — the numbers that legitimately differ between packages.
 *
 * The thresholds are a RATCHET FLOOR, not an aspirational target: each is the
 * measured baseline rounded down ~a point to absorb cross-runner noise, and
 * it only ever moves up. When coverage improves, raise the floor in the same
 * PR (read coverage/coverage-summary.json for the exact numbers). A floor is
 * never lowered to make a red build pass — that would defeat the ratchet.
 * Enforced in CI by the "Test + coverage gate" step in
 * .github/workflows/quality.yml.
 *
 * The floors were re-derived once, on the move to Vitest 4, by this same rule
 * from a fresh measurement. Vitest 4's v8 provider remaps through the AST
 * rather than v8-to-istanbul: it counts statements as statements rather than
 * as lines, counts a line only where a statement starts on it, and counts
 * functions differently. Its numbers do not compare with Vitest 3's, so some
 * floors moved down as well as up; the measure changed, not the coverage.
 * Each package's vitest.config.ts records the measurement and its Vitest 3
 * floors.
 */
export function coverageConfig(
  thresholds: CoverageThresholds,
  // Per-package extra excludes for files that live under src/ but are
  // test-only (never shipped, never exported) — keeping them out of the
  // denominator so the floor reflects shipped code.
  options?: { exclude?: string[] },
) {
  return {
    // v8 instrumentation: low overhead, no Babel transform, so the report
    // pass that `test:coverage` adds over a plain `vitest run` stays cheap.
    provider: "v8" as const,
    // Count untested src files against the floor too. Since Vitest 4 it is
    // `include` that does this (the old `all` flag is gone): without it, a
    // file with zero tests is simply absent from the denominator and the
    // ratchet cannot see coverage erode when new untested code lands.
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.test.ts", ...(options?.exclude ?? [])],
    reporter: ["text-summary", "json-summary"] as const,
    thresholds,
  };
}
