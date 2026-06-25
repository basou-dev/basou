/**
 * Performance budget — the single source of truth for read-side performance.
 * Establishes, at the CURRENT store scale, the thresholds the read-side commands
 * must stay within as the store grows, and the scaling shape the markdown
 * renderers must preserve.
 *
 * Two distinct kinds of number live here:
 *
 *   1. {@link WALL_CLOCK_BUDGET} — the USER-FACING contract. End-to-end command
 *      wall-clock (node boot + native-log staleness probe + store render). This
 *      is what a supervisor actually waits for. It is verified against the real
 *      store + a linear projection (see `perf-budget.test.ts`), not asserted in
 *      the default CI test run, because wall-clock on a shared CI runner is too
 *      noisy to gate on (promoting it to a hard CI gate is deliberately left to
 *      a later, dedicated quality-gate pass).
 *
 *   2. {@link RENDER_SCALING} — the ALGORITHMIC contract on the core renderers
 *      (`summarizeOrientation`, `renderDecisions`, `renderHandoff`). Each does a
 *      single streaming replay pass per session, so cost must grow at most
 *      LINEARLY in (sessions × events). The opt-in bench asserts this ratio,
 *      which is independent of absolute machine speed and is the real guard
 *      against a regression that only explodes at production scale.
 *
 * The decomposition matters: only the store-render portion scales with the
 * `.basou` store (sessions / decisions). Node boot is a fixed cost, and the
 * native-log staleness probe scales with the NATIVE LOG volume (~/.claude),
 * a separate axis from the store. This budget covers the store-render axis
 * (the `decisions.md` regeneration-cost concern); the native-log axis is
 * tracked separately (see the bench report).
 */

/** Measured baseline at the current real store (2026-06-25, warm). Documentation
 * only — the figures the budget below is derived from, recorded so a future
 * reader can see what "current scale" meant when the budget was set. */
export const MEASURED_BASELINE = Object.freeze({
  /** `.basou` store size the baseline was measured at. */
  sessions: 339,
  decisions: 927,
  /** decisions.md size in bytes (~455 B/decision observed). */
  decisionsFileBytes: 424_477,
  /** Native log footprint scanned by import / the staleness probe. */
  nativeLogBytes: 831 * 1024 * 1024,
  /** End-to-end command wall-clock, warm, including node boot + probe. */
  orientWallClockMs: 800,
  refreshIncrementalWallClockMs: 1_000,
});

/**
 * Target scale the budget must hold at. Adopting the full portfolio will inflate
 * the store; we set the budget BEFORE that so the threshold is grounded in the
 * current, honestly-measured baseline rather than back-fitted to whatever the
 * grown store happens to cost.
 */
export const TARGET_SCALE_MULTIPLIER = 2;

/**
 * User-facing end-to-end wall-clock budget at {@link TARGET_SCALE_MULTIPLIER}×
 * the current store. These are the THRESHOLDS, not assertions: the bench
 * measures the core renderers (no node boot / no native-log probe), so wall-clock
 * conformance is argued in the bench report from the real-store baseline plus the
 * measured render scaling — it is not enforced by a test here (a hard wall-clock
 * CI gate is deliberately left to a later, dedicated quality-gate pass).
 */
export const WALL_CLOCK_BUDGET = Object.freeze({
  orientMs: 1_500,
  refreshIncrementalMs: 3_000,
});

/**
 * Algorithmic contract on the core renderers. `maxRatio` is the ceiling on each
 * t(2N)/t(N) doubling step. The renderers do one streaming replay pass plus an
 * O(N log N) sort, so a clean run sits slightly ABOVE 2.0 (the log factor); a
 * value of 3.0 is slack for that term plus timing noise (GC, scheduling) while
 * still failing fast on a genuinely super-linear (e.g. accidental O(N²))
 * regression. Asserting the ratio across MULTIPLE doublings (see the bench)
 * tests the trend, which two points alone cannot.
 */
export const RENDER_SCALING = Object.freeze({
  /** Per-doubling t(2N)/t(N) ceiling. Near-linear ⇒ ~2.0–2.2; quadratic ⇒ ~4.0. */
  maxRatio: 3.0,
});

/**
 * Generous absolute ceiling for a single core render at the largest benched
 * scale. Set far above the measured core-render cost so it only trips on an
 * order-of-magnitude regression — it is a backstop, not a micro-benchmark. The
 * per-doubling ratio is the primary guard; this catches a catastrophic blowup
 * that clean ratios could still miss.
 */
export const RENDER_CEILING_MS = 4_000;
