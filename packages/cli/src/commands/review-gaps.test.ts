import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReviewGapsSummary, ReviewGapUnit } from "@basou/core";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunReviewGaps, parseWindow, renderReviewGaps } from "./review-gaps.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const WS = "ws_01HXABCDEF1234567890ABCDEF";
const NOW = new Date("2026-05-10T00:00:00.000Z");
const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s.padStart(3, "0")}`;

let tmpRepo: string | undefined;
beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-rg-cli-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
});
afterEach(async () => {
  if (tmpRepo !== undefined) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});
function repo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

async function setupWorkspace(): Promise<void> {
  const paths = await ensureBasouDirectory(repo());
  await writeManifest(paths, createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS }));
}

async function placeCommitSession(): Promise<void> {
  const paths = basouPaths(repo());
  const dir = join(paths.sessions, SES("C1"));
  await mkdir(dir, { recursive: true });
  await writeYamlFile(join(dir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: SES("C1"),
      label: "commit fixture",
      task_id: null,
      workspace_id: WS,
      source: { kind: "claude-code-import", version: "0.1.0" },
      started_at: "2026-05-09T10:00:00.000Z",
      status: "imported",
      working_directory: "/tmp/fixture",
      invocation: { command: "claude", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({
      schema_version: "0.1.0",
      id: "evt_01HXABCDEF1234567890AB0001",
      session_id: SES("C1"),
      occurred_at: "2026-05-09T10:05:00.000Z",
      source: "claude-code-import",
      type: "command_executed",
      command: "bash",
      args: ["-c", "cd /home/u/projects/alpha && git commit -m x"],
      cwd: "/x",
      exit_code: 0,
      duration_ms: 0,
    })}\n`,
  );
}

describe("parseWindow", () => {
  it("accepts a positive integer and rejects zero / negatives / non-integers", () => {
    expect(parseWindow("12")).toBe(12);
    expect(() => parseWindow("0")).toThrow(/positive integer/);
    expect(() => parseWindow("-3")).toThrow(/positive integer/);
    expect(() => parseWindow("1.5")).toThrow(/positive integer/);
    expect(() => parseWindow("abc")).toThrow(/positive integer/);
  });
});

describe("basou review-gaps", () => {
  it("resolves the workspace and returns the structured summary", async () => {
    await setupWorkspace();
    await placeCommitSession();
    const summary = await doRunReviewGaps({ json: true }, { cwd: repo(), nowProvider: () => NOW });
    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0]?.repo).toBe("alpha");
    expect(summary.gaps[0]?.verdict).toBe("omission");
  });

  it("prints the human report by default and JSON with --json", async () => {
    await setupWorkspace();
    await placeCommitSession();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => String(x)).join(" "));
    });
    try {
      await doRunReviewGaps({}, { cwd: repo(), nowProvider: () => NOW });
      await doRunReviewGaps({ json: true }, { cwd: repo(), nowProvider: () => NOW });
    } finally {
      spy.mockRestore();
    }
    expect(logs[0]).toContain("Review-trail gaps");
    const parsed = JSON.parse(logs[1] ?? "{}");
    expect(parsed.gaps[0].repo).toBe("alpha");
  });

  it("scope restricts the report to the named repo", async () => {
    await setupWorkspace();
    await placeCommitSession();
    const summary = await doRunReviewGaps(
      { repo: ["beta"], json: true },
      { cwd: repo(), nowProvider: () => NOW },
    );
    expect(summary.scope).toEqual(["beta"]);
    expect(summary.gaps).toHaveLength(0); // the only commit is in alpha
  });
});

function gapUnit(overrides: Partial<ReviewGapUnit> = {}): ReviewGapUnit {
  return {
    repo: "alpha",
    sessionId: SES("C1"),
    commitCount: 2,
    firstCommitAt: "2026-05-09T10:00:00.000Z",
    lastCommitAt: "2026-05-09T10:05:00.000Z",
    verdict: "omission",
    reviews: [],
    selfReports: [],
    ...overrides,
  };
}

function summaryOf(
  gaps: ReviewGapUnit[],
  unattached: Partial<ReviewGapsSummary["unattachedSelfReports"]> = {},
): ReviewGapsSummary {
  const counts = { noRepos: 0, unresolvableRepo: 0, noMatchingUnit: 0, ...unattached };
  return {
    generatedAt: NOW.toISOString(),
    windowHours: 24,
    scope: null,
    repos: [
      {
        repo: "alpha",
        units: gaps.length,
        omissionUnits: gaps.filter((u) => u.verdict === "omission").length,
        nearUnboundUnits: gaps.filter((u) => u.verdict === "near_unbound").length,
        candidateUnits: 0,
        unknownUnits: 0,
        selfReportedGapUnits: gaps.filter((u) => u.selfReports.length > 0).length,
      },
    ],
    gaps,
    candidates: [],
    unknowns: [],
    unattachedSelfReports: {
      ...counts,
      total: counts.noRepos + counts.unresolvableRepo + counts.noMatchingUnit,
    },
    newestCommitAt: "2026-05-09T10:05:00.000Z",
  };
}

function selfReport(
  overrides: Partial<ReviewGapUnit["selfReports"][number]> = {},
): ReviewGapUnit["selfReports"][number] {
  return {
    sessionId: SES("S1"),
    eventId: "evt_01HXABCDEF1234567890AB0001",
    reviewer: "gpt-5.6",
    target: "working-tree",
    recordedAt: "2026-05-09T09:30:00.000Z",
    commits: [],
    recordedAfterCommit: false,
    ...overrides,
  };
}

describe("renderReviewGaps", () => {
  it("labels a self-reported gap as unverified while still counting it as a gap", () => {
    const out = renderReviewGaps(summaryOf([gapUnit({ selfReports: [selfReport()] })]));
    expect(out).toContain("self-reported by gpt-5.6 — unverified, still counted");
    // The top-line count must not shrink because a record exists.
    expect(out).toContain("Units of work that landed without a review trail: 1");
    expect(out).toContain("no trail 1");
    expect(out).toContain("self-reported 1");
    expect(out).toContain("must not be a way to make the number go down");
  });

  it("shows the claimed commits as a claim, and flags a record written after the commit", () => {
    const out = renderReviewGaps(
      summaryOf([
        gapUnit({
          selfReports: [
            selfReport({ commits: ["a1b2c3d4e5f6", "0123456"], recordedAfterCommit: true }),
          ],
        }),
      ]),
    );
    expect(out).toContain("claiming a1b2c3d4, 0123456");
    expect(out).toContain("(recorded after the commit)");
    expect(out).toContain("unverified, still counted");
  });

  it("omits the label and the tally when no record named the repo", () => {
    const out = renderReviewGaps(summaryOf([gapUnit()]));
    expect(out).not.toContain("self-reported by");
    expect(out).not.toContain("/ self-reported");
    expect(out).not.toContain("changed nothing in this report");
  });

  it("names the cause of each record that changed nothing", () => {
    const out = renderReviewGaps(
      summaryOf([gapUnit()], { noRepos: 2, unresolvableRepo: 1, noMatchingUnit: 3 }),
    );
    expect(out).toContain("6 recorded reviews changed nothing in this report");
    expect(out).toContain("2 named no repository");
    expect(out).toContain("1 named a path that is not a repository root");
    expect(out).toContain("3 named a repository, but no captured unit of work");
    // The count is global, and says so, rather than vanishing under a scope.
    expect(out).toContain("not just any --repo scope");
  });

  it("does not assert the missing-`repos` cause for a record that had one", () => {
    const out = renderReviewGaps(summaryOf([gapUnit()], { noMatchingUnit: 1 }));
    expect(out).toContain("1 recorded review changed nothing");
    expect(out).not.toContain("named no repository");
  });

  it("shows the claim on a candidate unit too, not only on gaps", () => {
    const candidate = gapUnit({
      verdict: "candidate",
      reviews: [
        { sessionId: SES("R1"), examinedDiff: true, files: [], endedAt: NOW.toISOString() },
      ],
      selfReports: [selfReport({ reviewer: "codex" })],
    });
    const summary = summaryOf([]);
    const out = renderReviewGaps({ ...summary, candidates: [candidate] });
    // A bound record counts as attached, so it is absent from the unattached
    // diagnostic; if the line dropped it, it would exist only in --json.
    expect(out).toContain("review trace:");
    expect(out).toContain("self-reported by codex");
    // ...but a candidate is NOT in the gap count, so the gap wording must not
    // be reused here while the report also says there are zero gaps.
    expect(out).toContain("no unit of work landed without a review trail");
    expect(out).toContain("— unverified");
    expect(out).not.toContain("unverified, still counted");
  });

  it("truncates a reviewer name on a character boundary", () => {
    const out = renderReviewGaps(
      summaryOf([
        // 42 code points, so the 40-cap truncates exactly where the emoji sits
        gapUnit({ selfReports: [selfReport({ reviewer: `${"a".repeat(38)}\u{1F600}xyz` })] }),
      ]),
    );
    // Slicing UTF-16 units would land inside the surrogate pair and emit half a
    // character; the cap must fall on a code point.
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(out).toContain(`${"a".repeat(38)}\u{1F600}…`);
  });

  it("cannot let recorded text restructure the report", () => {
    const out = renderReviewGaps(
      summaryOf([
        gapUnit({
          selfReports: [
            selfReport({ reviewer: "evil\n## Injected heading", commits: ["abc\n- fake gap"] }),
          ],
        }),
      ]),
    );
    const injected = out
      .split("\n")
      .filter((l) => l.startsWith("## Injected") || l === "- fake gap");
    expect(injected).toEqual([]);
    expect(out).toContain("evil ## Injected heading");
  });

  it("caps how many self-reports one line renders", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      selfReport({ reviewer: `r${i}`, eventId: `evt_01HXABCDEF1234567890AB000${i}` }),
    );
    const out = renderReviewGaps(summaryOf([gapUnit({ selfReports: many })]));
    expect(out).toContain("+3 more");
    expect(out).not.toContain("r5");
  });
});
