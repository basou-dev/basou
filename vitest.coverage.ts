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
    // Count untested src files against the floor too. Without `all`, a file
    // with zero tests is simply absent from the denominator and the ratchet
    // cannot see coverage erode when new untested code lands.
    all: true,
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.test.ts", ...(options?.exclude ?? [])],
    reporter: ["text-summary", "json-summary"] as const,
    thresholds,
  };
}
