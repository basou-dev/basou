import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { renderDecisions } from "../decisions/index.js";
import { renderHandoff } from "../handoff/index.js";
import { summarizeOrientation } from "../orientation/index.js";
import {
  MEASURED_BASELINE,
  RENDER_CEILING_MS,
  RENDER_SCALING,
  TARGET_SCALE_MULTIPLIER,
} from "./budget.js";
import { buildSyntheticStore, type SyntheticStoreResult } from "./synthetic-store.js";

const NOW_ISO = "2026-06-26T00:00:00.000Z";

const dirs: string[] = [];
async function workDir(tag: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `basou-perf-${tag}-`));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) await rm(d, { recursive: true, force: true });
  }
});

/** Best-of-N wall-clock of an async render, in ms. Min is the least
 * noise-contaminated estimate of the true cost (noise only ever adds time). */
async function bestOf(runs: number, fn: () => Promise<unknown>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("perf smoke (CI guard)", () => {
  // Always-on, tiny scale: proves the renderers run end-to-end against a
  // generated store and that the generator's counts line up. Cheap enough to
  // sit in the default `vitest run`; the actual budget bench is opt-in below.
  it("renders a synthetic store correctly", async () => {
    const root = await workDir("smoke");
    const store = await buildSyntheticStore({ root, sessions: 8, decisionsPerSession: 3 });
    expect(store.decisionCount).toBe(24);

    const decisions = await renderDecisions({ paths: store.paths, nowIso: NOW_ISO });
    expect(decisions.decisionCount).toBe(24);
    expect(decisions.body).toContain("# Decisions");

    const handoff = await renderHandoff({ paths: store.paths, nowIso: NOW_ISO });
    expect(handoff.body.length).toBeGreaterThan(0);

    const orientation = await summarizeOrientation({ paths: store.paths, nowIso: NOW_ISO });
    expect(orientation.sessionCount).toBe(8);
  });
});

// Opt-in full-scale budget bench. Gated behind BASOU_PERF=1 so the default CI
// test run stays fast and is never gated on wall-clock (a shared-runner-noisy
// signal — promoting it to a hard gate is left to a later quality-gate pass).
// Run it with:
//   BASOU_PERF=1 pnpm --filter @basou/core test perf-budget
describe.runIf(process.env.BASOU_PERF === "1")("perf budget (full scale)", () => {
  const base = MEASURED_BASELINE.sessions;
  // Three points (1x, 2x, 4x of current scale) instead of two: a single
  // doubling cannot distinguish linear from super-linear growth, so we assert
  // the ratio holds across EACH doubling step. 4x brackets the near-term target.
  const multipliers = [1, TARGET_SCALE_MULTIPLIER, TARGET_SCALE_MULTIPLIER * 2];

  it("core renderers scale near-linearly across doublings and stay within budget", async () => {
    // Pair each multiplier with its store so later steps never index parallel
    // arrays (which would be `T | undefined` under noUncheckedIndexedAccess).
    const points: Array<{ mult: number; store: SyntheticStoreResult }> = [];
    for (const mult of multipliers) {
      const root = await workDir(`${mult}x`);
      points.push({ mult, store: await buildSyntheticStore({ root, sessions: base * mult }) });
    }

    const renderers: Array<{
      name: string;
      run: (paths: SyntheticStoreResult["paths"]) => Promise<unknown>;
    }> = [
      {
        name: "summarizeOrientation",
        run: (paths) => summarizeOrientation({ paths, nowIso: NOW_ISO }),
      },
      { name: "renderDecisions", run: (paths) => renderDecisions({ paths, nowIso: NOW_ISO }) },
      { name: "renderHandoff", run: (paths) => renderHandoff({ paths, nowIso: NOW_ISO }) },
    ];

    const rows: string[] = [];
    for (const r of renderers) {
      const measured: Array<{ mult: number; time: number }> = [];
      for (const p of points) {
        measured.push({ mult: p.mult, time: await bestOf(3, () => r.run(p.store.paths)) });
      }

      const cells = measured.map((m) => `${m.mult}x=${m.time.toFixed(1)}ms`);
      const ratioCells: string[] = [];
      // Near-linear scaling: each doubling must not super-linearly blow up the
      // render (the decisions.md regeneration-cost guard).
      for (let i = 1; i < measured.length; i++) {
        const prev = measured[i - 1];
        const cur = measured[i];
        if (prev === undefined || cur === undefined) continue;
        const ratio = cur.time / prev.time;
        ratioCells.push(ratio.toFixed(2));
        expect(
          ratio,
          `${r.name} ${prev.mult}x→${cur.mult}x ratio ${ratio.toFixed(2)} exceeds ${RENDER_SCALING.maxRatio}`,
        ).toBeLessThanOrEqual(RENDER_SCALING.maxRatio);
      }
      rows.push(`${r.name.padEnd(22)} ${cells.join("  ")}  ratios=${ratioCells.join(",")}`);

      // Catastrophic-regression backstop at the largest benched scale.
      const last = measured[measured.length - 1];
      if (last !== undefined) {
        expect(
          last.time,
          `${r.name} ${last.mult}x=${last.time.toFixed(1)}ms exceeds ${RENDER_CEILING_MS}ms`,
        ).toBeLessThanOrEqual(RENDER_CEILING_MS);
      }
    }

    const scaleSummary = points
      .map((p) => `${p.mult}x=${p.store.sessionCount}s/${p.store.decisionCount}d`)
      .join("  ");
    console.log(["", `perf budget bench — ${scaleSummary}`, ...rows, ""].join("\n"));
  }, 300_000);
});
