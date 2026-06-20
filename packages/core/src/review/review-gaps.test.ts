import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { findReviewGaps, normalizeRepoKey, normalizeRepoPath } from "./review-gaps.js";

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

  it("collapses a symlinked view to the real repo path regardless of the view's name", async () => {
    const base = getRoot();
    const realRepo = join(base, "myrepo");
    await mkdir(realRepo);
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
    await mkdir(repo);
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
    await mkdir(realRepo);
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

  it("does not collapse a non-`*-workspace` view that is absent on disk (fallback is name-bound)", () => {
    // realpath fails (absent), so the string fallback runs; it only collapses
    // `*-workspace` views, so an arbitrarily-named absent view keeps its literal
    // path. The live (on-disk) symlink case above is what generalizes the name.
    expect(normalizeRepoPath("/home/u/projects/dev-view/myrepo")).toBe(
      "/home/u/projects/dev-view/myrepo",
    );
  });
});
