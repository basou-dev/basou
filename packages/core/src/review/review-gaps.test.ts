import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { findReviewGaps, normalizeRepoKey } from "./review-gaps.js";

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
    exit_code: 0,
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
});
