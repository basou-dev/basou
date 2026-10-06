import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findReviewGaps,
  type ReviewGapUnit,
  type ReviewGapVerdict,
} from "../review/review-gaps.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { measureReviewGaps } from "./review-gaps.js";

// Pass-through vi.fn wrapper so one test can return a verdict this build does
// not give; every other call delegates to the real surfacer.
vi.mock("../review/review-gaps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../review/review-gaps.js")>();
  return { ...actual, findReviewGaps: vi.fn(actual.findReviewGaps) };
});

let root: string;
let paths: BasouPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basou-board-review-gaps-"));
  paths = await ensureBasouDirectory(root);
});

afterEach(async () => {
  vi.mocked(findReviewGaps).mockReset();
  await rm(root, { recursive: true, force: true });
});

function unit(verdict: string): ReviewGapUnit {
  return {
    repo: "alpha",
    sessionId: "ses_01HXABCDEF1234567890ABCS01",
    commitCount: 1,
    firstCommitAt: null,
    lastCommitAt: null,
    verdict: verdict as ReviewGapVerdict,
    reviews: [],
    selfReports: [],
    commitsWithUnobservedOutcome: 0,
  };
}

describe("measureReviewGaps", () => {
  it("counts a verdict it does not list as it is, after the others, and takes the gaps from basou review-gaps", async () => {
    vi.mocked(findReviewGaps).mockResolvedValueOnce({
      generatedAt: "2026-10-06T00:00:00.000Z",
      windowHours: 24,
      scope: null,
      repos: [],
      gaps: [unit("omission"), unit("waived")],
      candidates: [unit("candidate")],
      unknowns: [],
      unattachedSelfReports: {
        total: 0,
        noRepos: 0,
        unresolvableRepo: 0,
        noMatchingUnit: 0,
        unverifiableUnit: 0,
      },
      refusedPairings: 0,
      newestCommitAt: null,
    });
    const { reviewGaps, notFound } = await measureReviewGaps({
      paths,
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(reviewGaps.by_verdict).toEqual({
      omission: 1,
      near_unbound: 0,
      candidate: 1,
      unknown: 0,
      waived: 1,
    });
    expect(Object.keys(reviewGaps.by_verdict ?? {}).at(-1)).toBe("waived");
    expect(reviewGaps.gaps).toBe(2);
    expect(notFound).toEqual([]);
  });

  it("is not measured when basou review-gaps fails after the sessions were listed", async () => {
    vi.mocked(findReviewGaps).mockRejectedValueOnce(new Error("Failed to read"));
    const { reviewGaps, notFound } = await measureReviewGaps({
      paths,
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(reviewGaps).toEqual({ by_verdict: null, gaps: null });
    expect(notFound).toEqual([
      { at: "review_gaps", reason: "the sessions of the workspace could not be read" },
    ]);
  });
});
