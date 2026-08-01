import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import {
  findReviewGaps,
  findUnbindableRepos,
  normalizeRepoKey,
  normalizeRepoPath,
  resolveRepoRoot,
} from "./review-gaps.js";

const WS = "ws_01HXABCDEF1234567890ABCDEF";
const NOW = "2026-05-10T00:00:00.000Z";
const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s.padStart(3, "0")}`;

let workDir: string | undefined;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-rg-test-"));
});
afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});
function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

async function placeSession(
  paths: BasouPaths,
  fixture: { id: string; source: string; startedAt: string },
  eventLines: string[],
): Promise<void> {
  const dir = join(paths.sessions, fixture.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session.yaml"),
    stringify({
      schema_version: "0.1.0",
      session: {
        id: fixture.id,
        label: `fixture ${fixture.id.slice(-3)}`,
        task_id: null,
        workspace_id: WS,
        source: { kind: fixture.source, version: "0.1.0" },
        started_at: fixture.startedAt,
        status: "imported",
        working_directory: "/tmp/fixture",
        invocation: { command: fixture.source, args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
      },
    }),
  );
  await writeFile(join(dir, "events.jsonl"), `${eventLines.join("\n")}\n`);
}

let evtSeq = 0;
function cmd(
  sessionId: string,
  source: string,
  occurredAt: string,
  args: string[],
  cwd: string,
  exitCode = 0,
): string {
  evtSeq++;
  return JSON.stringify({
    schema_version: "0.1.0",
    id: `evt_01HXABCDEF1234567890AB${String(evtSeq).padStart(4, "0")}`,
    session_id: sessionId,
    occurred_at: occurredAt,
    source,
    type: "command_executed",
    command: "bash",
    args,
    cwd,
    exit_code: exitCode,
    duration_ms: 0,
  });
}

/** A `review_recorded` event line — the on-disk shape `basou review record` writes. */
function reviewRecorded(
  sessionId: string,
  occurredAt: string,
  fields: { reviewer?: string; target?: string; repos?: string[]; commits?: string[] } = {},
): string {
  evtSeq++;
  return JSON.stringify({
    schema_version: "0.1.0",
    id: `evt_01HXABCDEF1234567890AB${String(evtSeq).padStart(4, "0")}`,
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "local-cli",
    type: "review_recorded",
    reviewer: fields.reviewer ?? "codex",
    target: fields.target ?? "working-tree",
    ...(fields.repos !== undefined ? { repos: fields.repos } : {}),
    ...(fields.commits !== undefined ? { commits: fields.commits } : {}),
  });
}

const ALPHA = "/home/u/projects/alpha";

async function setup(): Promise<BasouPaths> {
  return ensureBasouDirectory(getWorkDir());
}

describe("normalizeRepoKey", () => {
  it("collapses a workspace-view-routed path to the same key as the direct path", () => {
    expect(normalizeRepoKey("/home/u/projects/foo-workspace/foo-planning")).toBe("foo-planning");
    expect(normalizeRepoKey("/home/u/projects/foo-planning")).toBe("foo-planning");
  });
  it("returns null for a view root, an unexpanded shell var, and empty input", () => {
    expect(normalizeRepoKey("/home/u/projects/foo-workspace")).toBeNull();
    expect(normalizeRepoKey('"$SMOKE_DIR"')).toBeNull();
    expect(normalizeRepoKey("")).toBeNull();
    expect(normalizeRepoKey(null)).toBeNull();
  });
});

describe("findReviewGaps", () => {
  it("flags a commit with no cross-model review as an omission (never 'clear')", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("C1"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C1"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.verdict).toBe("omission");
    expect(s.gaps[0]?.repo).toBe("alpha");
    expect(s.candidates).toHaveLength(0);
    // No verdict is ever an automatic pass / "clear".
    const verdicts = [...s.gaps, ...s.candidates].map((u) => u.verdict);
    expect(verdicts).not.toContain("clear");
  });

  it("a codex session that examined the repo diff before the commit is a CANDIDATE, not an auto-pass", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("R1"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        cmd(
          SES("R1"),
          "codex-import",
          "2026-05-09T09:30:00.000Z",
          ["-c", "git diff --name-status main"],
          ALPHA,
        ),
      ],
    );
    await placeSession(
      paths,
      { id: SES("C2"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C2"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(0);
    expect(s.candidates).toHaveLength(1);
    expect(s.candidates[0]?.verdict).toBe("candidate");
    expect(s.candidates[0]?.reviews[0]?.examinedDiff).toBe(true);
    expect(s.candidates[0]?.reviews[0]?.sessionId).toBe(SES("R1"));
  });

  it("a codex session NEARBY but not examining the diff/files is near_unbound (the false-clear class)", async () => {
    const paths = await setup();
    // codex read an unrelated file, never ran git diff
    await placeSession(
      paths,
      { id: SES("R2"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        cmd(
          SES("R2"),
          "codex-import",
          "2026-05-09T09:30:00.000Z",
          ["-c", "sed -n '1,5p' NOTES.md"],
          ALPHA,
        ),
      ],
    );
    // commit changed a different file
    await placeSession(
      paths,
      { id: SES("C3"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C3"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git add src/app.ts && git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.candidates).toHaveLength(0);
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.verdict).toBe("near_unbound");
    expect(s.gaps[0]?.reviews[0]?.sessionId).toBe(SES("R2"));
  });

  it("a review AFTER the commit (or outside the window) does not bind", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("R3"), source: "codex-import", startedAt: "2026-05-09T11:00:00.000Z" },
      [cmd(SES("R3"), "codex-import", "2026-05-09T11:30:00.000Z", ["-c", "git diff"], ALPHA)],
    );
    await placeSession(
      paths,
      { id: SES("C4"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C4"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.candidates).toHaveLength(0);
    expect(s.gaps[0]?.verdict).toBe("omission");
  });

  it("scope restricts to the named repo and reports a per-repo tally", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("C5"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C5"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "cd /home/u/projects/alpha && git commit -m a"],
          "/x",
        ),
        cmd(
          SES("C5"),
          "claude-code-import",
          "2026-05-09T10:06:00.000Z",
          ["-c", "cd /home/u/projects/beta && git commit -m b"],
          "/x",
        ),
      ],
    );
    const scoped = await findReviewGaps({ paths, nowIso: NOW, scope: ["alpha"] });
    expect(scoped.scope).toEqual(["alpha"]);
    expect(scoped.repos.map((r) => r.repo)).toEqual(["alpha"]);
    expect(scoped.gaps.every((u) => u.repo === "alpha")).toBe(true);

    const all = await findReviewGaps({ paths, nowIso: NOW });
    expect(all.repos.map((r) => r.repo).sort()).toEqual(["alpha", "beta"]);
  });

  it("derives the repo from an explicit `cd <repo> &&` when cwd is a view dir", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("C6"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C6"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "cd /home/u/projects/alpha-workspace/alpha && git commit -m x"],
          "/home/u/projects/alpha-workspace",
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.repos.map((r) => r.repo)).toEqual(["alpha"]);
  });

  it("does NOT bind a same-named repo at a different path (C2: no basename collision)", async () => {
    const paths = await setup();
    // a review that examined a DIFFERENT checkout that happens to be named "alpha"
    await placeSession(
      paths,
      { id: SES("R4"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        cmd(
          SES("R4"),
          "codex-import",
          "2026-05-09T09:30:00.000Z",
          ["-c", "git diff"],
          "/tmp/x/alpha",
        ),
      ],
    );
    await placeSession(
      paths,
      { id: SES("C7"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C7"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    // /tmp/x/alpha review must not clear the /home/u/projects/alpha commit
    expect(s.candidates).toHaveLength(0);
    expect(s.gaps[0]?.verdict).toBe("omission");
  });

  it("ignores failed commands (C3): a failed git commit is not landed work, a failed git diff is not evidence", async () => {
    const paths = await setup();
    // failed review diff (exit 1) must not bind
    await placeSession(
      paths,
      { id: SES("R5"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [cmd(SES("R5"), "codex-import", "2026-05-09T09:30:00.000Z", ["-c", "git diff"], ALPHA, 1)],
    );
    // failed commit (exit 1) must not count as a unit; a real commit follows
    await placeSession(
      paths,
      { id: SES("C8"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C8"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m fail"],
          ALPHA,
          1,
        ),
        cmd(
          SES("C8"),
          "claude-code-import",
          "2026-05-09T10:06:00.000Z",
          ["-c", "git commit -m ok"],
          ALPHA,
          0,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.candidates).toHaveLength(0); // failed diff did not bind
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.commitCount).toBe(1); // only the successful commit counted
    expect(s.gaps[0]?.verdict).toBe("omission");
  });

  it("surfaces a commit with an underivable repo as an unknown unit (C4), never dropping it", async () => {
    const paths = await setup();
    // cwd is a view ROOT (not a repo) and there is no `cd <repo>` -> repo underivable
    await placeSession(
      paths,
      { id: SES("C9"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C9"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          "/home/u/projects/foo-workspace",
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(0);
    expect(s.candidates).toHaveLength(0);
    expect(s.unknowns).toHaveLength(1);
    expect(s.unknowns[0]?.verdict).toBe("unknown");
    expect(s.unknowns[0]?.repo).toBe("(unknown)");
  });

  it("strips quotes around a `cd` path (C5) so a quoted commit binds its review", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("R6"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [cmd(SES("R6"), "codex-import", "2026-05-09T09:30:00.000Z", ["-c", "git diff"], ALPHA)],
    );
    await placeSession(
      paths,
      { id: SES("C10"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C10"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", 'cd "/home/u/projects/alpha" && git commit -m x'],
          "/elsewhere",
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    // quote stripped -> commit repo is "alpha" -> the alpha review binds as candidate
    expect(s.gaps).toHaveLength(0);
    expect(s.candidates[0]?.repo).toBe("alpha");
  });

  it("attributes a review's `cd <other> && git diff` to the other repo, not its cwd (C1)", async () => {
    const paths = await setup();
    // review session sits in alpha but inspects beta's diff via `cd`
    await placeSession(
      paths,
      { id: SES("R7"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        cmd(
          SES("R7"),
          "codex-import",
          "2026-05-09T09:30:00.000Z",
          ["-c", "cd /home/u/projects/beta && git diff"],
          ALPHA,
        ),
      ],
    );
    // a commit in alpha must NOT be cleared by that beta-directed review
    await placeSession(
      paths,
      { id: SES("C11"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("C11"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    const alpha = [...s.gaps, ...s.candidates].find((u) => u.repo === "alpha");
    expect(alpha?.verdict).toBe("omission");
  });
});

describe("normalizeRepoPath", () => {
  it("returns the full path (binding key) and collapses the view segment", () => {
    expect(normalizeRepoPath("/home/u/projects/foo-workspace/foo-planning")).toBe(
      "/home/u/projects/foo-planning",
    );
    expect(normalizeRepoPath("/home/u/projects/foo-planning")).toBe(
      "/home/u/projects/foo-planning",
    );
  });
  it("distinguishes same-named repos at different paths (no collision)", () => {
    expect(normalizeRepoPath("/tmp/x/alpha")).not.toBe(normalizeRepoPath("/home/u/projects/alpha"));
  });
  it("strips surrounding quotes and a trailing slash", () => {
    expect(normalizeRepoPath('"/home/u/projects/alpha"')).toBe("/home/u/projects/alpha");
    expect(normalizeRepoPath("/home/u/projects/alpha/")).toBe("/home/u/projects/alpha");
  });
  it("expands a leading ~ so it binds with the absolute form", () => {
    const tilde = normalizeRepoPath("~/projects/alpha");
    expect(tilde).toBe(normalizeRepoPath(`${homedir()}/projects/alpha`));
    expect(tilde?.startsWith("~")).toBe(false);
  });
  it("returns null for a view root, a shell var, and empty", () => {
    expect(normalizeRepoPath("/home/u/projects/foo-workspace")).toBeNull();
    expect(normalizeRepoPath('"$SMOKE_DIR"')).toBeNull();
    expect(normalizeRepoPath("")).toBeNull();
  });
});

describe("normalizeRepoPath (realpath resolution)", () => {
  let root: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "basou-rg-fs-"));
  });
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });
  function getRoot(): string {
    if (root === undefined) throw new Error("root not initialized");
    return root;
  }
  /** Create a directory that looks like a git repo root (has a `.git`). */
  async function mkRepo(p: string): Promise<void> {
    await mkdir(join(p, ".git"), { recursive: true });
  }

  it("collapses a symlinked view to the real repo path regardless of the view's name", async () => {
    const base = getRoot();
    const realRepo = join(base, "myrepo");
    await mkRepo(realRepo);
    // a view dir whose name is NOT `*-workspace`; the old string heuristic would
    // not collapse this, but realpath follows the symlink and does.
    const view = join(base, "dev-view");
    await mkdir(view);
    await symlink(realRepo, join(view, "myrepo"));

    const viewRouted = join(view, "myrepo");
    const canonical = await realpath(realRepo);
    expect(normalizeRepoPath(viewRouted)).toBe(canonical);
    // the view-routed path and the direct path collapse to one binding key
    expect(normalizeRepoPath(viewRouted)).toBe(normalizeRepoPath(realRepo));
  });

  it("binds a commit and a review reached through differently-named symlinked views", async () => {
    const base = getRoot();
    const repo = join(base, "alpha");
    await mkRepo(repo);
    const view = join(base, "dev-view"); // not `*-workspace`
    await mkdir(view);
    await symlink(repo, join(view, "alpha"));

    const paths = await ensureBasouDirectory(join(base, ".store"));
    // review examined the diff via the DIRECT repo path
    await placeSession(
      paths,
      { id: SES("RP1"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [cmd(SES("RP1"), "codex-import", "2026-05-09T09:30:00.000Z", ["-c", "git diff"], repo)],
    );
    // commit reached the same repo through the symlinked, non-`*-workspace` view
    await placeSession(
      paths,
      { id: SES("CP1"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("CP1"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", `cd ${join(view, "alpha")} && git commit -m x`],
          view,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    // realpath collapses both to the real repo, so the review binds as a candidate
    expect(s.gaps).toHaveLength(0);
    expect(s.candidates).toHaveLength(1);
    expect(s.candidates[0]?.repo).toBe("alpha");
    expect(s.candidates[0]?.reviews[0]?.sessionId).toBe(SES("RP1"));
  });

  it("caches a resolution: a repeat lookup survives the target being removed mid-run", async () => {
    const base = getRoot();
    const realRepo = join(base, "cached");
    await mkRepo(realRepo);
    const view = join(base, "view");
    await mkdir(view);
    const link = join(view, "cached");
    await symlink(realRepo, link);

    const first = normalizeRepoPath(link);
    expect(first).toBe(await realpath(realRepo));
    // remove the symlink: without caching, the repeat would realpath-fail and
    // fall back to a different (string-heuristic) key. The cache returns the
    // prior resolution, since the filesystem is assumed stable within a run.
    await rm(link);
    expect(normalizeRepoPath(link)).toBe(first);
  });

  it("abstains (null) for a real directory that is not a git repo root", async () => {
    const base = getRoot();
    const notRepo = join(base, "not-a-repo");
    await mkdir(notRepo); // a real directory, but no `.git`
    expect(normalizeRepoPath(notRepo)).toBeNull();
    // a sibling that IS a repo root still resolves
    const realRepo = join(base, "real-repo");
    await mkRepo(realRepo);
    expect(normalizeRepoPath(realRepo)).toBe(await realpath(realRepo));
  });

  it("a commit in a real non-git directory is an unknown unit, not a spurious repo", async () => {
    const base = getRoot();
    // a real directory that is NOT a git repo (e.g. a workspace view root, /tmp)
    const viewRoot = join(base, "a-view");
    await mkdir(viewRoot);
    const paths = await ensureBasouDirectory(join(base, ".store"));
    await placeSession(
      paths,
      { id: SES("CN1"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("CN1"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          viewRoot,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    // the non-repo directory must not surface as a repo; the commit abstains
    expect(s.repos.map((r) => r.repo)).not.toContain("a-view");
    expect(s.unknowns).toHaveLength(1);
    expect(s.unknowns[0]?.repo).toBe("(unknown)");
  });

  it("an explicit `cd <non-repo>` does not fall back to the cwd repo (no false candidate)", async () => {
    const base = getRoot();
    const repo = join(base, "alpha");
    await mkRepo(repo);
    const nonRepo = join(base, "scratch"); // real dir, no `.git`
    await mkdir(nonRepo);
    const paths = await ensureBasouDirectory(join(base, ".store"));
    // a "review" whose cwd is the repo but which `cd`s to a non-repo and runs git
    // diff there: it must NOT be credited to the repo cwd.
    await placeSession(
      paths,
      { id: SES("RN1"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        cmd(
          SES("RN1"),
          "codex-import",
          "2026-05-09T09:30:00.000Z",
          ["-c", `cd ${nonRepo} && git diff`],
          repo,
        ),
      ],
    );
    // a real commit in the repo
    await placeSession(
      paths,
      { id: SES("CN2"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("CN2"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          repo,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    // the cd-to-non-repo review is not credited to the repo, so the commit stays a gap
    expect(s.candidates).toHaveLength(0);
    expect(s.gaps.some((u) => u.repo === "alpha" && u.verdict === "omission")).toBe(true);
  });

  it("binds a self-reported review by `repos` but keeps the unit in gaps (a record never clears)", async () => {
    const paths = await setup();
    // the record lands in an ad-hoc session whose cwd is the PLANNING repo —
    // only `repos` can tie it to the repo actually reviewed.
    await placeSession(
      paths,
      { id: SES("S1"), source: "human", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        reviewRecorded(SES("S1"), "2026-05-09T09:30:00.000Z", {
          reviewer: "gpt-5.6",
          repos: [ALPHA],
          commits: ["a1b2c3d"],
        }),
      ],
    );
    await placeSession(
      paths,
      { id: SES("S2"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("S2"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    // The label appears...
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.selfReports).toHaveLength(1);
    expect(s.gaps[0]?.selfReports[0]?.reviewer).toBe("gpt-5.6");
    expect(s.gaps[0]?.selfReports[0]?.commits).toEqual(["a1b2c3d"]);
    // ...and the verdict / gap count are untouched: a self-report is not a clear.
    expect(s.gaps[0]?.verdict).toBe("omission");
    expect(s.candidates).toHaveLength(0);
    expect(s.repos[0]?.omissionUnits).toBe(1);
    expect(s.repos[0]?.selfReportedGapUnits).toBe(1);
    // Binding fields are internal; the emitted record carries only the report.
    expect(Object.keys(s.gaps[0]?.selfReports[0] ?? {}).sort()).toEqual([
      "commits",
      "eventId",
      "recordedAfterCommit",
      "recordedAt",
      "reviewer",
      "sessionId",
      "target",
    ]);
    expect(s.gaps[0]?.selfReports[0]?.recordedAfterCommit).toBe(false);
  });

  it("separates the causes of a record that changed nothing (no repos vs unresolvable repo)", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("S3"), source: "human", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        // no `repos` at all
        reviewRecorded(SES("S3"), "2026-05-09T09:30:00.000Z"),
        // `repos` present but unresolvable (a view root is not a repo)
        reviewRecorded(SES("S3"), "2026-05-09T09:31:00.000Z", {
          repos: ["/home/u/projects/foo-workspace"],
        }),
      ],
    );
    await placeSession(
      paths,
      { id: SES("S4"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("S4"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.unattachedSelfReports).toEqual({
      total: 2,
      noRepos: 1,
      unresolvableRepo: 1,
      noMatchingUnit: 0,
    });
    expect(s.gaps[0]?.selfReports).toHaveLength(0);
    expect(s.repos[0]?.selfReportedGapUnits).toBe(0);
  });

  it("reports a record whose repo resolved but reached no unit of work", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("S5"), source: "human", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        // resolvable repo, but no unit of work belongs to it
        reviewRecorded(SES("S5"), "2026-05-09T09:30:00.000Z", {
          repos: ["/home/u/projects/beta"],
        }),
      ],
    );
    await placeSession(
      paths,
      { id: SES("S6"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("S6"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps.find((u) => u.repo === "alpha")?.selfReports).toHaveLength(0);
    // The remaining silent case: nothing was wrong with the record itself.
    expect(s.unattachedSelfReports).toEqual({
      total: 1,
      noRepos: 0,
      unresolvableRepo: 0,
      noMatchingUnit: 1,
    });
  });

  it("attaches a record written after the commit, flagged, rather than hiding it", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("SP"), source: "human", startedAt: "2026-05-09T10:20:00.000Z" },
      [reviewRecorded(SES("SP"), "2026-05-09T10:30:00.000Z", { repos: [ALPHA] })],
    );
    await placeSession(
      paths,
      { id: SES("SQ"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("SQ"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    const alpha = s.gaps.find((u) => u.repo === "alpha");
    expect(alpha?.selfReports).toHaveLength(1);
    expect(alpha?.selfReports[0]?.recordedAfterCommit).toBe(true);
    // Still a gap: surfacing the claim is not accepting it.
    expect(alpha?.verdict).toBe("omission");
    expect(s.unattachedSelfReports.total).toBe(0);
  });

  it("does not attach a record older than the window (the window is load-bearing)", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("SW"), source: "human", startedAt: "2026-05-08T09:00:00.000Z" },
      [
        // 24h + 1ms before the commit, with the default 24h window
        reviewRecorded(SES("SW"), "2026-05-08T10:04:59.999Z", { repos: [ALPHA] }),
      ],
    );
    await placeSession(
      paths,
      { id: SES("SX"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("SX"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps.find((u) => u.repo === "alpha")?.selfReports).toHaveLength(0);
    expect(s.unattachedSelfReports.noMatchingUnit).toBe(1);
  });

  it("keeps the unattached diagnostic global under a repo scope", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("S7"), source: "human", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        // no repos at all -> unattached however the report is scoped
        reviewRecorded(SES("S7"), "2026-05-09T09:30:00.000Z"),
        // a BETA record that does attach to the beta unit; scoping to alpha must
        // not turn it into "matched nothing"
        reviewRecorded(SES("S7"), "2026-05-09T09:31:00.000Z", {
          repos: ["/home/u/projects/beta"],
        }),
      ],
    );
    await placeSession(
      paths,
      { id: SES("S8"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("S8"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ALPHA,
        ),
        cmd(
          SES("S8"),
          "claude-code-import",
          "2026-05-09T10:06:00.000Z",
          ["-c", "cd /home/u/projects/beta && git commit -m y"],
          ALPHA,
        ),
      ],
    );
    const unscoped = await findReviewGaps({ paths, nowIso: NOW });
    const scoped = await findReviewGaps({ paths, nowIso: NOW, scope: ["alpha"] });
    expect(unscoped.unattachedSelfReports).toEqual({
      total: 1,
      noRepos: 1,
      unresolvableRepo: 0,
      noMatchingUnit: 0,
    });
    // Identical under the scope: it is a caveat about input handling, not repo data.
    expect(scoped.unattachedSelfReports).toEqual(unscoped.unattachedSelfReports);
    expect(scoped.gaps.every((u) => u.repo === "alpha")).toBe(true);
  });

  it("labels a near_unbound unit with a self-report without promoting it to candidate", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("S9"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        cmd(
          SES("S9"),
          "codex-import",
          "2026-05-09T09:30:00.000Z",
          ["-c", "sed -n '1,5p' NOTES.md"],
          ALPHA,
        ),
      ],
    );
    await placeSession(
      paths,
      { id: SES("SA"), source: "human", startedAt: "2026-05-09T09:40:00.000Z" },
      [reviewRecorded(SES("SA"), "2026-05-09T09:45:00.000Z", { repos: [ALPHA] })],
    );
    await placeSession(
      paths,
      { id: SES("SB"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("SB"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git add src/app.ts && git commit -m x"],
          ALPHA,
        ),
      ],
    );
    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.candidates).toHaveLength(0);
    expect(s.gaps[0]?.verdict).toBe("near_unbound");
    expect(s.gaps[0]?.selfReports).toHaveLength(1);
  });

  it("findUnbindableRepos rejects hand-typed paths that could never match a commit", async () => {
    const base = getRoot();
    const repoDir = join(base, "myrepo");
    await mkRepo(repoDir);
    await mkdir(join(repoDir, "packages"), { recursive: true });

    // The whole point of the strict check: normalizeRepoPath ACCEPTS all three
    // of these (its string fallback exists for captured data), so a writer that
    // reused it would store keys no commit can ever match.
    expect(normalizeRepoPath("../myrepo")).not.toBeNull();
    expect(normalizeRepoPath(join(base, "myrepoo"))).not.toBeNull();

    expect(findUnbindableRepos([repoDir])).toEqual([]);
    expect(findUnbindableRepos(["../myrepo"])).toEqual([
      { repo: "../myrepo", problem: "relative" },
    ]);
    expect(findUnbindableRepos([join(base, "myrepoo")])).toEqual([
      { repo: join(base, "myrepoo"), problem: "absent" },
    ]);
    expect(findUnbindableRepos([join(repoDir, "packages")])).toEqual([
      { repo: join(repoDir, "packages"), problem: "not_a_repo_root" },
    ]);
  });

  it("everything findUnbindableRepos accepts resolves to the same key the reader binds with", async () => {
    const base = getRoot();
    const repoDir = join(base, "myrepo");
    await mkRepo(repoDir);
    const viewLink = join(base, "some-view");
    await mkdir(viewLink, { recursive: true });
    await symlink(repoDir, join(viewLink, "myrepo"));

    // The asymmetry must run the safe way: the writer is stricter, never looser.
    for (const accepted of [repoDir, join(viewLink, "myrepo"), `${repoDir}/`]) {
      expect(findUnbindableRepos([accepted])).toEqual([]);
      expect(normalizeRepoPath(accepted)).toBe(await realpath(repoDir));
      expect(resolveRepoRoot(accepted)).toBe(await realpath(repoDir));
    }
  });

  it("does not collapse a non-`*-workspace` view that is absent on disk (fallback is name-bound)", () => {
    // realpath fails (absent), so the string fallback runs; it only collapses
    // `*-workspace` views, so an arbitrarily-named absent view keeps its literal
    // path. The live (on-disk) symlink case above is what generalizes the name.
    expect(normalizeRepoPath("/home/u/projects/dev-view/myrepo")).toBe(
      "/home/u/projects/dev-view/myrepo",
    );
  });
});
