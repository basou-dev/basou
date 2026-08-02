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
const SES = (s: string): string => {
  // Crockford base32 excludes I, L, O and U; an id containing one is rejected as
  // malformed and its session silently skipped, which quietly changes what a
  // fixture is testing.
  if (/[ILOU]/.test(s)) throw new Error(`fixture id '${s}' uses a non-ULID character`);
  return `ses_01HXABCDEF1234567890ABC${s.padStart(3, "0")}`;
};

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
  fields: {
    reviewer?: string;
    target?: string;
    repos?: string[];
    reposResolved?: string[];
    commits?: string[];
  } = {},
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
    ...(fields.reposResolved !== undefined ? { repos_resolved: fields.reposResolved } : {}),
    ...(fields.commits !== undefined ? { commits: fields.commits } : {}),
  });
}

const ALPHA = "/home/u/projects/alpha";

async function setup(): Promise<BasouPaths> {
  return ensureBasouDirectory(getWorkDir());
}

describe("SES fixture guard", () => {
  it("rejects an id containing a character Crockford base32 excludes", () => {
    // A fixture id with `I` was rejected as malformed, so its session silently
    // vanished and the test it anchored proved nothing.
    expect(() => SES("PI")).toThrow(/non-ULID character/);
    expect(() => SES("PK")).not.toThrow();
  });
});

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
      { repo: "../myrepo", index: 0, problem: "relative" },
    ]);
    expect(findUnbindableRepos([join(base, "myrepoo")])).toEqual([
      { repo: join(base, "myrepoo"), index: 0, problem: "absent" },
    ]);
    expect(findUnbindableRepos([join(repoDir, "packages")])).toEqual([
      { repo: join(repoDir, "packages"), index: 0, problem: "not_a_repo_root" },
    ]);
    // Two identical bad entries are two problems at two positions; matching by
    // value would name the first twice and lose the second.
    expect(findUnbindableRepos(["../a", repoDir, "../a"]).map((u) => u.index)).toEqual([0, 2]);
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

/**
 * Self-reports bind on STRICTLY resolved repository roots, so these fixtures
 * need real directories — a made-up path is (correctly) reported as
 * unresolvable rather than minting a key no commit can match.
 */
describe("findReviewGaps — self-reported reviews", () => {
  let root: string | undefined;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "basou-rg-sr-")));
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
  async function mkRepo(name: string): Promise<string> {
    const p = join(getRoot(), name);
    await mkdir(join(p, ".git"), { recursive: true });
    return p;
  }
  async function placeCommits(
    paths: BasouPaths,
    id: string,
    repo: string,
    times: string[],
  ): Promise<void> {
    await placeSession(
      paths,
      { id, source: "claude-code-import", startedAt: times[0] as string },
      times.map((t) => cmd(id, "claude-code-import", t, ["-c", "git commit -m x"], repo)),
    );
  }
  async function placeRecords(paths: BasouPaths, id: string, lines: string[]): Promise<void> {
    await placeSession(paths, { id, source: "human", startedAt: NOW }, lines);
  }

  it("binds by repos and keeps the unit in gaps (a record never clears)", async () => {
    const paths = await setup();
    const repo = await mkRepo("alpha");
    await placeRecords(paths, SES("S1"), [
      reviewRecorded(SES("S1"), "2026-05-09T09:30:00.000Z", {
        reviewer: "gpt-5.6",
        repos: [repo],
        commits: ["a1b2c3d"],
      }),
    ]);
    await placeCommits(paths, SES("S2"), repo, ["2026-05-09T10:05:00.000Z"]);

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.selfReports).toHaveLength(1);
    expect(s.gaps[0]?.selfReports[0]?.reviewer).toBe("gpt-5.6");
    expect(s.gaps[0]?.selfReports[0]?.commits).toEqual(["a1b2c3d"]);
    expect(s.gaps[0]?.selfReports[0]?.recordedAfterCommit).toBe(false);
    // The verdict and the gap count are untouched: a self-report is not a clear.
    expect(s.gaps[0]?.verdict).toBe("omission");
    expect(s.candidates).toHaveLength(0);
    expect(s.repos[0]?.selfReportedGapUnits).toBe(1);
    // Binding fields are internal; the emitted record carries just the report.
    expect(Object.keys(s.gaps[0]?.selfReports[0] ?? {}).sort()).toEqual([
      "commits",
      "eventId",
      "recordedAfterCommit",
      "recordedAt",
      "reviewer",
      "sessionId",
      "target",
    ]);
  });

  it("prefers repos_resolved, so a retargeted symlink cannot move an old claim", async () => {
    const paths = await setup();
    const alpha = await mkRepo("alpha");
    const beta = await mkRepo("beta");
    const view = join(getRoot(), "view");
    await mkdir(view, { recursive: true });
    const viewLink = join(view, "repo");
    await symlink(alpha, viewLink);

    await placeRecords(paths, SES("S1"), [
      // written against the view path, but resolved at write time to alpha
      reviewRecorded(SES("S1"), "2026-05-09T09:30:00.000Z", {
        reviewer: "pinned",
        repos: [viewLink],
        reposResolved: [await realpath(alpha)],
      }),
      // a legacy record with only the spelling, re-resolved at read time
      reviewRecorded(SES("S1"), "2026-05-09T09:31:00.000Z", {
        reviewer: "unpinned",
        repos: [viewLink],
      }),
    ]);
    await placeCommits(paths, SES("S2"), alpha, ["2026-05-09T10:05:00.000Z"]);
    await placeCommits(paths, SES("S3"), beta, ["2026-05-09T10:06:00.000Z"]);

    // the view is repointed after the records were written
    await rm(viewLink);
    await symlink(beta, viewLink);

    const s = await findReviewGaps({ paths, nowIso: NOW });
    const on = (repo: string): string[] =>
      (s.gaps.find((u) => u.repo === repo)?.selfReports ?? []).map((r) => r.reviewer);
    // resolved-at-write-time still points where the review actually happened
    expect(on("alpha")).toContain("pinned");
    expect(on("beta")).not.toContain("pinned");
    // the legacy spelling follows the symlink to the wrong repo — the instability
    // `repos_resolved` exists to remove
    expect(on("beta")).toContain("unpinned");
  });

  it("separates the causes of a record that changed nothing", async () => {
    const paths = await setup();
    const repo = await mkRepo("alpha");
    const notARepo = join(getRoot(), "scratch");
    await mkdir(notARepo, { recursive: true });
    await placeRecords(paths, SES("S1"), [
      reviewRecorded(SES("S1"), "2026-05-09T09:30:00.000Z"),
      reviewRecorded(SES("S1"), "2026-05-09T09:31:00.000Z", { repos: [notARepo] }),
      // a path that is simply gone: it must be reported as unresolvable, NOT as
      // "no work in the window" — that would assert a cause never established
      reviewRecorded(SES("S1"), "2026-05-09T09:32:00.000Z", {
        repos: [join(getRoot(), "vanished")],
      }),
    ]);
    await placeCommits(paths, SES("S2"), repo, ["2026-05-09T10:05:00.000Z"]);

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.unattachedSelfReports).toEqual({
      total: 3,
      noRepos: 1,
      unresolvableRepo: 2,
      noMatchingUnit: 0,
      unverifiableUnit: 0,
    });
    expect(s.gaps[0]?.selfReports).toHaveLength(0);
  });

  it("reports a resolvable repo that reached no unit of work", async () => {
    const paths = await setup();
    const alpha = await mkRepo("alpha");
    const beta = await mkRepo("beta");
    await placeRecords(paths, SES("S1"), [
      reviewRecorded(SES("S1"), "2026-05-09T09:30:00.000Z", { repos: [beta] }),
    ]);
    await placeCommits(paths, SES("S2"), alpha, ["2026-05-09T10:05:00.000Z"]);

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.unattachedSelfReports).toEqual({
      total: 1,
      noRepos: 0,
      unresolvableRepo: 0,
      noMatchingUnit: 1,
      unverifiableUnit: 0,
    });
  });

  it("attaches a record written after the commit, flagged, rather than hiding it", async () => {
    const paths = await setup();
    const repo = await mkRepo("alpha");
    await placeRecords(paths, SES("S1"), [
      reviewRecorded(SES("S1"), "2026-05-09T10:30:00.000Z", { repos: [repo] }),
    ]);
    await placeCommits(paths, SES("S2"), repo, ["2026-05-09T10:05:00.000Z"]);

    const s = await findReviewGaps({ paths, nowIso: NOW });
    const alpha = s.gaps.find((u) => u.repo === "alpha");
    expect(alpha?.selfReports[0]?.recordedAfterCommit).toBe(true);
    // Surfacing the claim is not accepting it.
    expect(alpha?.verdict).toBe("omission");
    expect(s.unattachedSelfReports.total).toBe(0);
  });

  it("does not attach a record older than the window (the window is load-bearing)", async () => {
    const paths = await setup();
    const repo = await mkRepo("alpha");
    await placeRecords(paths, SES("S1"), [
      // 24h + 1ms before the commit, with the default 24h window
      reviewRecorded(SES("S1"), "2026-05-08T10:04:59.999Z", { repos: [repo] }),
    ]);
    await placeCommits(paths, SES("S2"), repo, ["2026-05-09T10:05:00.000Z"]);

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps.find((u) => u.repo === "alpha")?.selfReports).toHaveLength(0);
    expect(s.unattachedSelfReports.noMatchingUnit).toBe(1);
  });

  it("keeps the unattached diagnostic global under a repo scope", async () => {
    const paths = await setup();
    const alpha = await mkRepo("alpha");
    const beta = await mkRepo("beta");
    await placeRecords(paths, SES("S1"), [
      reviewRecorded(SES("S1"), "2026-05-09T09:30:00.000Z"),
      // attaches to the BETA unit; scoping to alpha must not make it "matched nothing"
      reviewRecorded(SES("S1"), "2026-05-09T09:31:00.000Z", { repos: [beta] }),
    ]);
    await placeCommits(paths, SES("S2"), alpha, ["2026-05-09T10:05:00.000Z"]);
    await placeCommits(paths, SES("S3"), beta, ["2026-05-09T10:06:00.000Z"]);

    const unscoped = await findReviewGaps({ paths, nowIso: NOW });
    const scoped = await findReviewGaps({ paths, nowIso: NOW, scope: ["alpha"] });
    expect(unscoped.unattachedSelfReports).toEqual({
      total: 1,
      noRepos: 1,
      unresolvableRepo: 0,
      noMatchingUnit: 0,
      unverifiableUnit: 0,
    });
    expect(scoped.unattachedSelfReports).toEqual(unscoped.unattachedSelfReports);
    expect(scoped.gaps.every((u) => u.repo === "alpha")).toBe(true);
  });

  it("labels a near_unbound unit without promoting it to candidate", async () => {
    const paths = await setup();
    const repo = await mkRepo("alpha");
    await placeSession(
      paths,
      { id: SES("R1"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [cmd(SES("R1"), "codex-import", "2026-05-09T09:30:00.000Z", ["-c", "cat NOTES.md"], repo)],
    );
    await placeRecords(paths, SES("S1"), [
      reviewRecorded(SES("S1"), "2026-05-09T09:45:00.000Z", { repos: [repo] }),
    ]);
    await placeSession(
      paths,
      { id: SES("S2"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("S2"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git add src/app.ts && git commit -m x"],
          repo,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.candidates).toHaveLength(0);
    expect(s.gaps[0]?.verdict).toBe("near_unbound");
    expect(s.gaps[0]?.selfReports).toHaveLength(1);
  });

  it("attaches to a candidate unit as well, so the claim is not lost behind a trace", async () => {
    const paths = await setup();
    const repo = await mkRepo("alpha");
    await placeSession(
      paths,
      { id: SES("R1"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [cmd(SES("R1"), "codex-import", "2026-05-09T09:30:00.000Z", ["-c", "git diff"], repo)],
    );
    await placeRecords(paths, SES("S1"), [
      reviewRecorded(SES("S1"), "2026-05-09T09:45:00.000Z", { repos: [repo] }),
    ]);
    await placeCommits(paths, SES("S2"), repo, ["2026-05-09T10:05:00.000Z"]);

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.candidates).toHaveLength(1);
    expect(s.candidates[0]?.selfReports).toHaveLength(1);
    // Attached, so it must not also be reported as having reached nothing.
    expect(s.unattachedSelfReports.total).toBe(0);
  });
});

/** Round-3 regressions: provenance decides strictness, not which field it came from. */
describe("findReviewGaps — record key provenance", () => {
  let root: string | undefined;
  beforeEach(async () => {
    // realpath'd: on macOS `mkdtemp` returns a /var path that resolves to
    // /private/var, and that difference alone can make keys disagree — masking
    // whether the code under test actually decided anything.
    root = await realpath(await mkdtemp(join(tmpdir(), "basou-rg-pv-")));
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

  it("refuses to pair a record with work in a repository that is no longer here", async () => {
    const paths = await setup();
    // The commit keeps its old path through the string fallback and still forms
    // a unit, so the two strings DO match. basou declines anyway: nothing on
    // disk can confirm they name the same repository, and a guess about whether
    // a review happened is worse than saying it cannot be checked.
    const gone = join(getRoot(), "moved-away");
    await placeSession(paths, { id: SES("P1"), source: "human", startedAt: NOW }, [
      reviewRecorded(SES("P1"), "2026-05-09T09:30:00.000Z", { reposResolved: [gone] }),
    ]);
    await placeSession(
      paths,
      { id: SES("P2"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("P2"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          gone,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.selfReports).toHaveLength(0);
    // Reported as unverifiable, not silently dropped and not called a miss.
    expect(s.unattachedSelfReports).toEqual({
      total: 1,
      noRepos: 0,
      unresolvableRepo: 1,
      noMatchingUnit: 0,
      unverifiableUnit: 0,
    });
  });

  it("separates a path it cannot check from a repository with no work in the window", async () => {
    const paths = await setup();
    const gone = join(getRoot(), "moved-away");
    const live = join(getRoot(), "alpha");
    await mkdir(join(live, ".git"), { recursive: true });
    await placeSession(paths, { id: SES("P3"), source: "human", startedAt: NOW }, [
      // not on disk: basou cannot check this one at all
      reviewRecorded(SES("P3"), "2026-05-09T09:30:00.000Z", { repos: [gone] }),
      // on disk, but no captured work belongs to it: a different problem
      reviewRecorded(SES("P3"), "2026-05-09T09:31:00.000Z", { repos: [live] }),
    ]);

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.unattachedSelfReports).toEqual({
      total: 2,
      noRepos: 0,
      unresolvableRepo: 1,
      noMatchingUnit: 1,
      unverifiableUnit: 0,
    });
  });

  it("refuses to pair when only the unit's key survived a name-based collapse", async () => {
    const paths = await setup();
    // The repository IS here, but the commit was captured through a view path
    // that is not: the unit's key comes from the `*-workspace` string collapse,
    // a heuristic on a directory name. Both sides must name a repository that
    // resolves, or the pairing is still a guess.
    const live = join(getRoot(), "bar");
    await mkdir(join(live, ".git"), { recursive: true });
    const removedView = join(getRoot(), "foo-workspace", "bar");
    await placeSession(paths, { id: SES("PA"), source: "human", startedAt: NOW }, [
      reviewRecorded(SES("PA"), "2026-05-09T09:30:00.000Z", { repos: [live] }),
    ]);
    await placeSession(
      paths,
      { id: SES("PB"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("PB"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          removedView,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    // The collapse still forms a unit — that part is existing behaviour — but no
    // claim attaches to it.
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.selfReports).toHaveLength(0);
    // ...and the reason says so. Calling this "no work in the window" would deny
    // a unit that is right there in the report above it.
    expect(s.unattachedSelfReports.unverifiableUnit).toBe(1);
    expect(s.unattachedSelfReports.noMatchingUnit).toBe(0);
  });

  it("refuses a unit where only SOME commits came from a verified path", async () => {
    const paths = await setup();
    const live = join(getRoot(), "bar");
    await mkdir(join(live, ".git"), { recursive: true });
    const removedView = join(getRoot(), "foo-workspace", "bar");
    await placeSession(paths, { id: SES("PC"), source: "human", startedAt: NOW }, [
      reviewRecorded(SES("PC"), "2026-05-09T09:30:00.000Z", { repos: [live] }),
    ]);
    // One session, two commits sharing a key: one path resolved, the other only
    // collapsed to it by name. One resolved commit must not vouch for a sibling
    // whose origin was guessed at.
    await placeSession(
      paths,
      { id: SES("PD"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("PD"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          live,
        ),
        cmd(
          SES("PD"),
          "claude-code-import",
          "2026-05-09T10:06:00.000Z",
          ["-c", "git commit -m y"],
          removedView,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps[0]?.commitCount).toBe(2);
    expect(s.gaps[0]?.selfReports).toHaveLength(0);
    expect(s.unattachedSelfReports.unverifiableUnit).toBe(1);
  });

  it("resolves a relative `cd` target against the captured cwd", async () => {
    const paths = await setup();
    // Two sessions each running `cd ../app`, from different places. Left as the
    // literal spelling both would key `../app` and their work would pair.
    const x = join(getRoot(), "x");
    const y = join(getRoot(), "y");
    await mkdir(join(x, "app", ".git"), { recursive: true });
    await mkdir(join(y, "app", ".git"), { recursive: true });
    await mkdir(join(x, "here"), { recursive: true });
    await mkdir(join(y, "here"), { recursive: true });
    await placeSession(
      paths,
      { id: SES("PE"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [
        cmd(
          SES("PE"),
          "codex-import",
          "2026-05-09T09:30:00.000Z",
          ["-c", "cd ../app && git diff"],
          join(x, "here"),
        ),
      ],
    );
    await placeSession(
      paths,
      { id: SES("PF"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("PF"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "cd ../app && git commit -m x"],
          join(y, "here"),
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    // The review examined x/app; the commit landed in y/app. Keying both as
    // `../app` would call this a candidate — the one verdict this must never
    // reach by accident.
    expect(s.candidates).toHaveLength(0);
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.verdict).toBe("omission");
  });

  it("abstains on a relative `cd` when the captured cwd is not absolute", async () => {
    const paths = await setup();
    // The importers write `cwd: "."` when the shell's directory was not
    // recorded. Joining to that would resolve against whatever directory
    // review-gaps happens to run in, crediting the work to a repository next
    // door to the operator's terminal.
    await placeSession(
      paths,
      { id: SES("PG"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("PG"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "cd ../app && git commit -m x"],
          ".",
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(0);
    expect(s.unknowns).toHaveLength(1);
    expect(s.unknowns[0]?.verdict).toBe("unknown");
  });

  it("abstains on shell-special `cd` forms rather than minting a shared key", async () => {
    const paths = await setup();
    const base = getRoot();
    // `-` is $OLDPWD, `$VAR` held different values per session, `~user` is
    // another account. Keyed literally, two unrelated sessions would share
    // `<cwd>/-` or `$ROOT/app` and produce a false candidate.
    for (const [i, target] of ["-", "$ROOT/app", "~someone/app"].entries()) {
      await placeSession(
        paths,
        {
          id: SES(`H${i}`),
          source: "claude-code-import",
          startedAt: "2026-05-09T10:00:00.000Z",
        },
        [
          cmd(
            SES(`H${i}`),
            "claude-code-import",
            "2026-05-09T10:05:00.000Z",
            ["-c", `cd ${target} && git commit -m x`],
            base,
          ),
        ],
      );
    }

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(0);
    expect(s.unknowns).toHaveLength(3);
  });

  it("reports a refused pairing even when the record attached to another unit", async () => {
    const paths = await setup();
    const live = join(getRoot(), "bar");
    await mkdir(join(live, ".git"), { recursive: true });
    const removedView = join(getRoot(), "foo-workspace", "bar");
    await placeSession(paths, { id: SES("PH"), source: "human", startedAt: NOW }, [
      reviewRecorded(SES("PH"), "2026-05-09T09:30:00.000Z", { repos: [live] }),
    ]);
    // one unit it CAN pair with...
    await placeSession(
      paths,
      { id: SES("PK"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("PK"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          live,
        ),
      ],
    );
    // ...and one it cannot, whose key only name-collapsed onto the same repo
    await placeSession(
      paths,
      { id: SES("PJ"), source: "claude-code-import", startedAt: "2026-05-09T10:10:00.000Z" },
      [
        cmd(
          SES("PJ"),
          "claude-code-import",
          "2026-05-09T10:15:00.000Z",
          ["-c", "git commit -m y"],
          removedView,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    // It attached once, so it is not "a record that changed nothing"...
    expect(s.unattachedSelfReports.total).toBe(0);
    // ...but the pairing it could not be checked against is still reported.
    expect(s.refusedPairings).toBe(1);
  });

  it("does not let two missing-cwd sessions share the key `.`", async () => {
    const paths = await setup();
    // Both importers write "." when no directory was captured. Keyed literally,
    // an unrelated review and an unrelated commit pair as a CANDIDATE and the
    // gap count falls to zero.
    await placeSession(
      paths,
      { id: SES("QA"), source: "codex-import", startedAt: "2026-05-09T09:00:00.000Z" },
      [cmd(SES("QA"), "codex-import", "2026-05-09T09:30:00.000Z", ["-c", "git diff"], ".")],
    );
    await placeSession(
      paths,
      { id: SES("QB"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("QB"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          ".",
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.candidates).toHaveLength(0);
    expect(s.gaps).toHaveLength(0);
    expect(s.unknowns).toHaveLength(1);
  });

  it("keeps a verified path whose real name contains a `$`", async () => {
    const paths = await setup();
    // The `$` heuristic exists for unexpanded variables. A directory realpath
    // confirmed is a real directory, whatever its name.
    const odd = join(getRoot(), "acme$cash");
    await mkdir(join(odd, ".git"), { recursive: true });
    await placeSession(
      paths,
      { id: SES("QC"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("QC"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          odd,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.unknowns).toHaveLength(0);
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.repo).toBe("acme$cash");
  });

  it("still rejects an unexpanded variable that no directory backs", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("QD"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("QD"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", 'cd "$ROOT/app" && git commit -m x'],
          getRoot(),
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(0);
    expect(s.unknowns).toHaveLength(1);
  });

  it("does not mistake the characters `cd &&` inside a commit message for a directory change", async () => {
    const paths = await setup();
    const live = join(getRoot(), "alpha");
    await mkdir(join(live, ".git"), { recursive: true });
    for (const [i, line] of [
      "git commit -m 'docs: explain cd && behavior'",
      "git add docs-cd && git commit -m x",
    ].entries()) {
      await placeSession(
        paths,
        {
          id: SES(`Q${i}`),
          source: "claude-code-import",
          startedAt: "2026-05-09T10:00:00.000Z",
        },
        [cmd(SES(`Q${i}`), "claude-code-import", "2026-05-09T10:05:00.000Z", ["-c", line], live)],
      );
    }

    const s = await findReviewGaps({ paths, nowIso: NOW });
    // Both commits are perfectly derivable: they ran in `live`.
    expect(s.unknowns).toHaveLength(0);
    expect(s.gaps).toHaveLength(2);
    expect(s.gaps.every((u) => u.repo === "alpha")).toBe(true);
  });

  it("abstains on a genuine bare `cd &&`", async () => {
    const paths = await setup();
    const live = join(getRoot(), "alpha");
    await mkdir(join(live, ".git"), { recursive: true });
    await placeSession(
      paths,
      { id: SES("QE"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("QE"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "cd && git commit -m x"],
          live,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(0);
    expect(s.unknowns).toHaveLength(1);
  });

  it("reports undeterminable work even under a repo scope", async () => {
    const paths = await setup();
    await placeSession(
      paths,
      { id: SES("QF"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("QF"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "cd ../app && git commit -m x"],
          ".",
        ),
      ],
    );

    // Suppressing these under a scope produced zero gaps, zero unknowns and a
    // success line for work the tool could not place.
    const scoped = await findReviewGaps({ paths, nowIso: NOW, scope: ["alpha"] });
    expect(scoped.unknowns).toHaveLength(1);
  });

  it("finds a `cd` that begins a line of a multi-line script", async () => {
    const paths = await setup();
    const a = join(getRoot(), "repo-a");
    const b = join(getRoot(), "repo-b");
    await mkdir(join(a, ".git"), { recursive: true });
    await mkdir(join(b, ".git"), { recursive: true });
    // Both importers keep the whole script in one argument. Treating only
    // punctuation as a separator missed every `cd` that began a line, and the
    // command was then credited to the cwd -- a wrong repository, not an
    // abstention.
    await placeSession(
      paths,
      { id: SES("RA"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("RA"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "echo ready\ncd " + b + " && git commit -m x"],
          a,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.repo).toBe("repo-b");
  });

  it("ignores a separator that only appears inside a quoted string", async () => {
    const paths = await setup();
    const a = join(getRoot(), "repo-a");
    const b = join(getRoot(), "repo-b");
    await mkdir(join(a, ".git"), { recursive: true });
    await mkdir(join(b, ".git"), { recursive: true });
    // The `;` is inside a commit message, so the shell never changes directory.
    // Reading it as a separator attributed repo-a's work to repo-b.
    await placeSession(
      paths,
      { id: SES("RB"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("RB"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m 'docs; cd " + b + " && behavior'"],
          a,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]?.repo).toBe("repo-a");
  });

  it("keeps a scoped report's tally and footer about the scoped repository", async () => {
    const paths = await setup();
    const alpha = join(getRoot(), "alpha");
    await mkdir(join(alpha, ".git"), { recursive: true });
    await placeSession(
      paths,
      { id: SES("RC"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("RC"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          alpha,
        ),
      ],
    );
    // A later, unrelated commit that cannot be placed at all.
    await placeSession(
      paths,
      { id: SES("RD"), source: "claude-code-import", startedAt: "2026-05-09T11:00:00.000Z" },
      [
        cmd(
          SES("RD"),
          "claude-code-import",
          "2026-05-09T11:30:00.000Z",
          ["-c", "git commit -m y"],
          ".",
        ),
      ],
    );

    const scoped = await findReviewGaps({ paths, nowIso: NOW, scope: ["alpha"] });
    // Listed as a caveat...
    expect(scoped.unknowns).toHaveLength(1);
    // ...without becoming a row in a tally headed "By repository", or the
    // scoped report's "newest captured commit".
    expect(scoped.repos.map((r) => r.repo)).toEqual(["alpha"]);
    expect(scoped.newestCommitAt).toBe("2026-05-09T10:05:00.000Z");
  });

  it("refuses to key a record from a relative path", async () => {
    const paths = await setup();
    // Both spellings would collapse to the literal key `../app`, binding a
    // record written beside one repository to a commit made beside another.
    await placeSession(paths, { id: SES("P7"), source: "human", startedAt: NOW }, [
      reviewRecorded(SES("P7"), "2026-05-09T09:30:00.000Z", { repos: ["../app"] }),
    ]);
    await placeSession(
      paths,
      { id: SES("P8"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("P8"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "cd ../app && git commit -m x"],
          join(getRoot(), "unrelated"),
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps.flatMap((u) => u.selfReports)).toHaveLength(0);
    expect(s.unattachedSelfReports.unresolvableRepo).toBe(1);
  });

  it("does not let an empty repos_resolved shadow a populated repos", async () => {
    const paths = await setup();
    const live = join(getRoot(), "alpha");
    await mkdir(join(live, ".git"), { recursive: true });
    // The writer never emits this shape, but an imported event may carry it.
    await placeSession(paths, { id: SES("P4"), source: "human", startedAt: NOW }, [
      reviewRecorded(SES("P4"), "2026-05-09T09:30:00.000Z", {
        repos: [live],
        reposResolved: [],
      }),
    ]);
    await placeSession(
      paths,
      { id: SES("P5"), source: "claude-code-import", startedAt: "2026-05-09T10:00:00.000Z" },
      [
        cmd(
          SES("P5"),
          "claude-code-import",
          "2026-05-09T10:05:00.000Z",
          ["-c", "git commit -m x"],
          live,
        ),
      ],
    );

    const s = await findReviewGaps({ paths, nowIso: NOW });
    expect(s.gaps[0]?.selfReports).toHaveLength(1);
    expect(s.unattachedSelfReports.noRepos).toBe(0);
  });
});
