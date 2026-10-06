import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { chainEvents } from "../events/chain.js";
import type { Event } from "../schemas/event.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { type BoardDeclaration, parseBoardDeclaration } from "./declaration.js";
import { type BoardMeasurement, boardDigest, measureBoard } from "./measure.js";

const NULL_CONFIG = process.platform === "win32" ? "\\\\.\\nul" : "/dev/null";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: NULL_CONFIG, GIT_CONFIG_SYSTEM: NULL_CONFIG };
const NOW = new Date("2026-10-05T03:00:00.000Z");
const WITH = { basou: "0.0.0-test", build: null };
const WS = "ws_01HXABCDEF1234567890ABCDEF";
const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s}`;
const EVT = (s: string): string => `evt_01HXABCDEF1234567890ABC${s}`;
const DEC = (s: string): string => `decision_01HXABCDEF1234567890ABC${s}`;
const TASK = (s: string): string => `task_01HXABCDEF1234567890ABC${s}`;

let root: string;
let paths: BasouPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basou-board-measure-"));
  paths = await ensureBasouDirectory(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" });
}

// A repository `name` under the root with `committed` files on main, then
// `worktree` files written but not committed.
async function repo(
  name: string,
  committed: Record<string, string>,
  worktree: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  for (const [path, body] of Object.entries(committed)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  for (const [path, body] of Object.entries(worktree)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}

const STAGES = Object.fromEntries(
  ["01", "02", "03", "04", "05", "06"].map((id) => [id, { meaning: `stage ${id}` }]),
);

function declare(
  measures: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  repos: readonly string[] = ["app"],
): BoardDeclaration {
  const text = stringify({
    board_version: 1,
    title: "Test board",
    stages: STAGES,
    lanes: [{ id: "core", name: "Core" }],
    measures,
    axis: { version: 1, review_due_days: 60 },
    effort: { start: "2026-04-28" },
    ...extra,
  });
  const result = parseBoardDeclaration(text, { manifestRepoPaths: repos });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.declaration;
}

function measure(
  declaration: BoardDeclaration,
  now: Date = NOW,
  repos: readonly string[] = [],
): Promise<BoardMeasurement> {
  return measureBoard({ declaration, root, repos, paths, now, measuredWith: WITH });
}

function measured(m: BoardMeasurement, id: string): unknown {
  return m.measures[id]?.value;
}

describe("measureBoard: files in the working tree and at a revision", () => {
  beforeEach(async () => {
    const dir = await repo(
      "app",
      {
        ".gitignore": "dist/\n",
        "README.md": "# app\n",
        "src/a.ts": "one\ntwo\n",
        "src/b.ts": "one\ntwo\nthree", // no newline at the end
        "src/a.test.ts": "test\n",
        "src/old.ts": "gone\n",
        "src/lib/c.ts": "x\r\ny\r\n",
      },
      { "src/new.ts": "fresh\n", "dist/out.ts": "built\n" },
    );
    await unlink(join(dir, "src/old.ts")); // tracked, deleted from the working tree
  });

  it("counts tracked and untracked files on disk, not ignored or deleted ones", async () => {
    const m = await measure(
      declare([
        {
          id: "ts",
          kind: "file_count",
          repo: "app",
          include: ["**/*.ts"],
          exclude: ["**/*.test.ts"],
          unit: "files",
        },
        {
          id: "ts_main",
          kind: "file_count",
          repo: "app",
          include: ["**/*.ts"],
          exclude: ["**/*.test.ts"],
          at: "main",
          unit: "files",
        },
      ]),
    );
    // a, b, lib/c, new — dist/out.ts is ignored and old.ts is deleted.
    expect(measured(m, "ts")).toBe(4);
    // a, b, lib/c, old — new.ts was never committed.
    expect(measured(m, "ts_main")).toBe(4);
    expect(m.complete).toBe(true);
    expect(m.not_found).toEqual([]);
  });

  it("reads several files at a revision, and matches the end of a CRLF line", async () => {
    const m = await measure(
      declare([
        {
          id: "lines_main",
          kind: "line_count",
          repo: "app",
          include: ["src/*.ts", "src/lib/*.ts"],
          exclude: ["**/*.test.ts"],
          at: "main",
          unit: "lines",
        },
        {
          id: "ends_main",
          kind: "match_count",
          repo: "app",
          include: ["src/*.ts", "src/lib/*.ts"],
          pattern: "^(two|y|gone)$",
          at: "main",
          unit: "lines",
        },
      ]),
    );
    // a 2 + b 3 + old 1 + lib/c 2, read in one batch at main.
    expect(measured(m, "lines_main")).toBe(8);
    // "two" in a and b, "gone" in old, "y" in lib/c once its \r is dropped.
    expect(measured(m, "ends_main")).toBe(4);
  });

  it("counts a last line with no newline, and a CRLF line once", async () => {
    const m = await measure(
      declare([
        {
          id: "lines",
          kind: "line_count",
          repo: "app",
          include: ["src/*.ts", "src/lib/*.ts"],
          exclude: ["**/*.test.ts"],
          unit: "lines",
        },
        {
          id: "lines_main",
          kind: "line_count",
          repo: "app",
          include: ["src/b.ts"],
          at: "main",
          unit: "lines",
        },
      ]),
    );
    // a 2 + b 3 + new 1 + lib/c 2
    expect(measured(m, "lines")).toBe(8);
    expect(measured(m, "lines_main")).toBe(3);
  });

  it("counts the directories at a depth that hold a counted file", async () => {
    const m = await measure(
      declare([
        { id: "dirs", kind: "dir_count", repo: "app", path: ".", depth: 1, unit: "dirs" },
        { id: "src_dirs", kind: "dir_count", repo: "app", path: "src", depth: 1, unit: "dirs" },
        {
          id: "test_dirs",
          kind: "dir_count",
          repo: "app",
          path: ".",
          depth: 1,
          include: ["**/*.test.ts"],
          unit: "dirs",
        },
      ]),
    );
    expect(measured(m, "dirs")).toBe(1); // src (dist is ignored)
    expect(measured(m, "src_dirs")).toBe(1); // lib
    expect(measured(m, "test_dirs")).toBe(1);
  });

  it("reports what is not there instead of counting zero", async () => {
    const m = await measure(
      declare(
        [
          { id: "no_repo", kind: "file_count", repo: "gone", include: ["*"], unit: "files" },
          {
            id: "no_rev",
            kind: "file_count",
            repo: "app",
            include: ["*"],
            at: "nope",
            unit: "files",
          },
          {
            id: "no_file",
            kind: "match_count",
            repo: "app",
            include: ["CHANGELOG.md"],
            pattern: "^- ",
            unit: "entries",
          },
          { id: "no_dir", kind: "file_count", repo: "app", include: ["lib/*.ts"], unit: "files" },
          {
            id: "no_path",
            kind: "dir_count",
            repo: "app",
            path: "packages",
            depth: 1,
            unit: "dirs",
          },
          { id: "zero", kind: "file_count", repo: "app", include: ["src/*.md"], unit: "files" },
        ],
        {},
        ["app", "gone"],
      ),
    );
    expect(m.measures).toMatchObject({
      no_repo: { value: null },
      no_rev: { value: null },
      no_file: { value: null },
      no_dir: { value: null },
      no_path: { value: null },
      zero: { value: 0 },
    });
    expect(m.complete).toBe(false);
    expect(m.not_found).toEqual([
      { at: "measures.no_repo", reason: "the repo 'gone' is not on disk" },
      { at: "measures.no_rev", reason: "the repo 'app' (at 'nope') has no revision 'nope'" },
      { at: "measures.no_file", reason: "'CHANGELOG.md' matches no file in the working tree" },
      { at: "measures.no_dir", reason: "nothing is under 'lib' in the working tree" },
      { at: "measures.no_path", reason: "nothing is under 'packages' in the working tree" },
    ]);
  });

  it("reports a directory that is not a repository, or not the root of one", async () => {
    await mkdir(join(root, "plain"));
    const m = await measure(
      declare(
        [
          { id: "plain", kind: "file_count", repo: "plain", include: ["*"], unit: "files" },
          { id: "inner", kind: "file_count", repo: "app/src", include: ["*"], unit: "files" },
        ],
        {},
        ["plain", "app/src"],
      ),
    );
    expect(m.not_found).toEqual([
      { at: "measures.plain", reason: "the repo 'plain' is not a git repository" },
      {
        at: "measures.inner",
        reason: "the repo 'app/src' is inside a git repository but is not its root",
      },
    ]);
  });
});

describe("measureBoard: lines that match", () => {
  beforeEach(async () => {
    await repo("app", {
      "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- one\n- two\n\n## 0.2.0\n\n- old\n",
      "RELEASED.md": "# Changelog\n\n## 0.2.0\n\n- old\n",
      "notes/a.md": "- x\n- y\n",
      "notes/b.md": "- z\n",
    });
  });

  it("counts the lines of a section, between its start and the next end", async () => {
    const section = { start: "^## Unreleased", end: "^## ", on_missing: "zero" };
    const m = await measure(
      declare([
        {
          id: "unreleased",
          kind: "match_count",
          repo: "app",
          include: ["CHANGELOG.md"],
          pattern: "^- ",
          section,
          unit: "entries",
        },
        {
          id: "none_yet",
          kind: "match_count",
          repo: "app",
          include: ["RELEASED.md"],
          pattern: "^- ",
          section,
          unit: "entries",
        },
        {
          id: "all",
          kind: "match_count",
          repo: "app",
          include: ["notes/*.md"],
          pattern: "^- ",
          unit: "entries",
        },
      ]),
    );
    expect(measured(m, "unreleased")).toBe(2);
    expect(measured(m, "none_yet")).toBe(0); // on_missing: zero
    expect(measured(m, "all")).toBe(3);
    expect(m.complete).toBe(true);
  });

  it("reports a section that is not there when on_missing is null", async () => {
    const m = await measure(
      declare([
        {
          id: "strict",
          kind: "match_count",
          repo: "app",
          include: ["RELEASED.md"],
          pattern: "^- ",
          section: { start: "^## Unreleased", on_missing: null },
          unit: "entries",
        },
      ]),
    );
    expect(m.not_found).toEqual([
      { at: "measures.strict", reason: "no line of 'RELEASED.md' matches the section start" },
    ]);
  });

  it("takes the group of the first matching line, and reports a pattern that matches nothing", async () => {
    const m = await measure(
      declare([
        {
          id: "latest",
          kind: "regex_capture",
          repo: "app",
          file: "CHANGELOG.md",
          pattern: "^## ([0-9][^ ]*)",
          unit: "version",
        },
        {
          id: "whole",
          kind: "regex_capture",
          repo: "app",
          file: "CHANGELOG.md",
          pattern: "^## U\\w+",
          group: 0,
          unit: "heading",
        },
        {
          id: "absent",
          kind: "regex_capture",
          repo: "app",
          file: "CHANGELOG.md",
          pattern: "^### (.*)",
          unit: "x",
        },
        {
          id: "optional",
          kind: "regex_capture",
          repo: "app",
          file: "CHANGELOG.md",
          pattern: "^## (x)?Unreleased",
          unit: "x",
        },
        {
          id: "in_section",
          kind: "regex_capture",
          repo: "app",
          file: "CHANGELOG.md",
          pattern: "^- (.*)",
          section: { start: "^## 0\\.2\\.0", on_missing: null },
          unit: "entry",
        },
      ]),
    );
    expect(measured(m, "latest")).toBe("0.2.0");
    expect(measured(m, "whole")).toBe("## Unreleased");
    expect(measured(m, "in_section")).toBe("old");
    expect(m.not_found).toEqual([
      { at: "measures.absent", reason: "no line of 'CHANGELOG.md' matches the pattern" },
      {
        at: "measures.optional",
        reason: "group 1 took no part in the first match in 'CHANGELOG.md'",
      },
    ]);
  });
});

describe("measureBoard: JSON", () => {
  beforeEach(async () => {
    await repo("app", {
      "tilde.json": JSON.stringify({ "~1": [1, 2], "/": [1] }),
      "package.json": JSON.stringify({
        files: ["dist", "README.md"],
        bin: { a: "x", b: "y" },
        name: "app",
        "a/b": [1],
      }),
      "bad.json": "{ not json",
      "bom.json": "\uFEFF[1, 2, 3]",
    });
  });

  it("counts the entries of the array or object a pointer names", async () => {
    const m = await measure(
      declare([
        {
          id: "files",
          kind: "json_length",
          repo: "app",
          file: "package.json",
          pointer: "/files",
          unit: "items",
        },
        {
          id: "bin",
          kind: "json_length",
          repo: "app",
          file: "package.json",
          pointer: "/bin",
          unit: "items",
        },
        {
          id: "root",
          kind: "json_length",
          repo: "app",
          file: "package.json",
          pointer: "",
          unit: "keys",
        },
        {
          id: "escaped",
          kind: "json_length",
          repo: "app",
          file: "package.json",
          pointer: "/a~1b",
          unit: "items",
        },
        {
          id: "tilde",
          kind: "json_length",
          repo: "app",
          file: "tilde.json",
          pointer: "/~01",
          unit: "items",
        },
        {
          id: "bom",
          kind: "json_length",
          repo: "app",
          file: "bom.json",
          pointer: "",
          unit: "items",
        },
      ]),
    );
    expect(m.measures).toMatchObject({
      files: { value: 2 },
      bin: { value: 2 },
      root: { value: 4 },
      escaped: { value: 1 },
      tilde: { value: 2 },
      bom: { value: 3 },
    });
  });

  it("reports a pointer at nothing, at a scalar, a file that is not JSON or not there", async () => {
    const m = await measure(
      declare([
        {
          id: "nothing",
          kind: "json_length",
          repo: "app",
          file: "package.json",
          pointer: "/nope",
          unit: "x",
        },
        {
          id: "index",
          kind: "json_length",
          repo: "app",
          file: "package.json",
          pointer: "/files/01",
          unit: "x",
        },
        {
          id: "scalar",
          kind: "json_length",
          repo: "app",
          file: "package.json",
          pointer: "/name",
          unit: "x",
        },
        { id: "bad", kind: "json_length", repo: "app", file: "bad.json", pointer: "", unit: "x" },
        {
          id: "missing",
          kind: "json_length",
          repo: "app",
          file: "none.json",
          pointer: "",
          unit: "x",
        },
      ]),
    );
    expect(m.not_found).toEqual([
      { at: "measures.nothing", reason: "'/nope' points at nothing in 'package.json'" },
      { at: "measures.index", reason: "'/files/01' points at nothing in 'package.json'" },
      { at: "measures.scalar", reason: "'/name' in 'package.json' is not an array or an object" },
      { at: "measures.bad", reason: "'bad.json' is not valid JSON in the working tree" },
      { at: "measures.missing", reason: "'none.json' is not a file in the working tree" },
    ]);
  });
});

describe.skipIf(process.platform === "win32")("measureBoard: symlinks", () => {
  it("follows a symlink inside the repository and refuses one that leaves it", async () => {
    const dir = await repo("app", { "docs/real.md": "a\nb\n" });
    await writeFile(join(root, "secret.md"), "s\n");
    await symlink("real.md", join(dir, "docs/inside.md"));
    await symlink("../../secret.md", join(dir, "docs/outside.md"));
    await symlink("missing.md", join(dir, "docs/dangling.md"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "links");
    const m = await measure(
      declare([
        {
          id: "inside",
          kind: "line_count",
          repo: "app",
          include: ["docs/inside.md"],
          unit: "lines",
        },
        {
          id: "inside_main",
          kind: "line_count",
          repo: "app",
          include: ["docs/inside.md"],
          at: "main",
          unit: "lines",
        },
        { id: "both", kind: "file_count", repo: "app", include: ["docs/*.md"], unit: "files" },
        {
          id: "both_main",
          kind: "file_count",
          repo: "app",
          include: ["docs/*.md"],
          at: "main",
          unit: "files",
        },
        {
          id: "real_only",
          kind: "file_count",
          repo: "app",
          include: ["docs/*.md"],
          exclude: ["docs/outside.md"],
          unit: "files",
        },
      ]),
    );
    expect(measured(m, "inside")).toBe(2);
    expect(measured(m, "inside_main")).toBe(2);
    // The dangling link is not a file; the one that leaves the repository is refused.
    expect(measured(m, "real_only")).toBe(2);
    expect(m.not_found).toEqual([
      { at: "measures.both", reason: "'docs/outside.md' is a symlink to outside the repository" },
      {
        at: "measures.both_main",
        reason: "'docs/outside.md' is a symlink to outside the repository",
      },
    ]);
  });

  it("refuses an absolute symlink and does not count a symlink to a directory", async () => {
    const dir = await repo("app", { "docs/real.md": "a\n", "sub/x.md": "x\n" });
    await writeFile(join(root, "secret.md"), "s\n");
    await symlink(join(root, "secret.md"), join(dir, "docs/abs.md"));
    await symlink("../sub", join(dir, "docs/dirlink"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "links");
    const m = await measure(
      declare([
        { id: "abs", kind: "file_count", repo: "app", include: ["docs/abs.md"], unit: "files" },
        {
          id: "abs_main",
          kind: "file_count",
          repo: "app",
          include: ["docs/abs.md"],
          at: "main",
          unit: "files",
        },
        {
          id: "files",
          kind: "file_count",
          repo: "app",
          include: ["docs/*"],
          exclude: ["docs/abs.md"],
          unit: "files",
        },
        {
          id: "files_main",
          kind: "file_count",
          repo: "app",
          include: ["docs/*"],
          exclude: ["docs/abs.md"],
          at: "main",
          unit: "files",
        },
      ]),
    );
    // docs/dirlink ends at a directory, which is not a file.
    expect(measured(m, "files")).toBe(1);
    expect(measured(m, "files_main")).toBe(1);
    expect(m.not_found).toEqual([
      { at: "measures.abs", reason: "'docs/abs.md' is a symlink to outside the repository" },
      { at: "measures.abs_main", reason: "'docs/abs.md' is a symlink to outside the repository" },
    ]);
  });
});

async function placeSession(id: string, events: string): Promise<void> {
  const dir = join(paths.sessions, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session.yaml"),
    stringify({
      schema_version: "0.1.0",
      session: {
        id,
        label: "fixture",
        task_id: null,
        workspace_id: WS,
        source: { kind: "terminal", version: "0.1.0" },
        started_at: "2026-10-01T00:00:00Z",
        status: "completed",
        working_directory: "/tmp/fixture",
        invocation: { command: "echo", args: [], exit_code: 0 },
        related_files: [],
        events_log: "events.jsonl",
      },
    }),
  );
  await writeFile(join(dir, "events.jsonl"), events);
}

function line(sessionId: string, evt: string, fields: Record<string, unknown>): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    id: EVT(evt),
    session_id: sessionId,
    occurred_at: "2026-10-01T00:00:00Z",
    source: "local-cli",
    ...fields,
  })}\n`;
}

async function placeTask(id: string, status: string): Promise<void> {
  const yaml = stringify({
    schema_version: "0.1.0",
    task: {
      id,
      title: `task ${id.slice(-3)}`,
      status,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      workspace_id: WS,
      created_in_session: SES("S01"),
      linked_sessions: [SES("S01")],
    },
  });
  await writeFile(join(paths.tasks, `${id}.md`), `---\n${yaml}---\n\n`);
}

describe("measureBoard: the workspace's own trail", () => {
  const TRAIL = [
    { id: "all", kind: "trail_count", of: "decisions_all", unit: "decisions" },
    { id: "live", kind: "trail_count", of: "decisions_live", unit: "decisions" },
    { id: "tracks", kind: "trail_count", of: "tracks_open", unit: "tracks" },
    { id: "tasks", kind: "trail_count", of: "tasks", unit: "tasks" },
    { id: "doing", kind: "trail_count", of: "tasks", status: "in_progress", unit: "tasks" },
  ];

  it("counts decisions, voided ones, open tracks and tasks from the events", async () => {
    const s1 = SES("S01");
    const s2 = SES("S02");
    await placeSession(
      s1,
      line(s1, "E01", { type: "decision_recorded", decision_id: DEC("D01"), title: "a" }) +
        line(s1, "E02", {
          type: "decision_recorded",
          decision_id: DEC("D02"),
          title: "b",
          kind: "track",
        }) +
        line(s1, "E03", {
          type: "decision_recorded",
          decision_id: DEC("D03"),
          title: "c",
          kind: "track",
        }),
    );
    await placeSession(
      s2,
      line(s2, "E04", { type: "decision_voided", decision_id: DEC("D03") }) +
        line(s2, "E05", {
          type: "decision_recorded",
          decision_id: DEC("D04"),
          title: "d",
          kind: "decision",
        }),
    );
    await placeTask(TASK("T01"), "in_progress");
    await placeTask(TASK("T02"), "done");
    await placeTask(TASK("T03"), "in_progress");
    const m = await measure(declare(TRAIL));
    expect(m.measures).toMatchObject({
      all: { value: 4 },
      live: { value: 3 },
      tracks: { value: 1 },
      tasks: { value: 3 },
      doing: { value: 2 },
    });
    expect(m.trail).toEqual({
      decisions_all: 4,
      decisions_live: 3,
      tracks_open: [{ id: DEC("D02"), title: "b" }],
    });
    expect(m.complete).toBe(true);
  });

  it("does not count tasks when one of them cannot be read", async () => {
    await placeTask(TASK("T01"), "done");
    await writeFile(join(paths.tasks, `${TASK("T02")}.md`), "not a task\n");
    const skipped: string[] = [];
    const m = await measureBoard({
      declaration: declare(TRAIL),
      root,
      repos: [],
      paths,
      now: NOW,
      measuredWith: WITH,
      onTaskSkip: (taskId) => skipped.push(taskId),
    });
    expect(skipped).toEqual([TASK("T02")]);
    expect(m.measures).toMatchObject({
      all: { value: 0 },
      tasks: { value: null },
      doing: { value: null },
    });
    expect(m.not_found).toEqual([
      { at: "measures.tasks", reason: "1 task could not be read" },
      { at: "measures.doing", reason: "1 task could not be read" },
    ]);
  });
});

describe("measureBoard: ratios, the digest and the result's shape", () => {
  beforeEach(async () => {
    await repo("app", { "a.ts": "1\n2\n3\n4\n", "a.test.ts": "1\n2\n", "empty.ts": "" });
  });

  const MEASURES = [
    { id: "src", kind: "line_count", repo: "app", include: ["a.ts"], unit: "lines", lane: "core" },
    { id: "test", kind: "line_count", repo: "app", include: ["a.test.ts"], unit: "lines" },
    { id: "empty", kind: "line_count", repo: "app", include: ["empty.ts"], unit: "lines" },
    { id: "gone", kind: "line_count", repo: "app", include: ["gone.ts"], unit: "lines" },
  ];

  it("divides two measures, and reports a division by zero but not a missing input twice", async () => {
    const m = await measure(
      declare(MEASURES, {
        ratios: [
          { id: "test_to_src", label: "r", numerator: "test", denominator: "src" },
          { id: "by_zero", label: "r", numerator: "src", denominator: "empty" },
          { id: "of_gone", label: "r", numerator: "gone", denominator: "src" },
        ],
      }),
    );
    expect(m.ratios).toEqual({
      test_to_src: { value: 0.5, numerator: "test", denominator: "src" },
      by_zero: { value: null, numerator: "src", denominator: "empty" },
      of_gone: { value: null, numerator: "gone", denominator: "src" },
    });
    expect(m.not_found).toEqual([
      { at: "measures.gone", reason: "'gone.ts' matches no file in the working tree" },
      { at: "ratios.by_zero", reason: "'empty' is 0" },
    ]);
  });

  it("puts the declared fields in order, with each measure's unit and lane", async () => {
    const m = await measure(declare(MEASURES.slice(0, 2)));
    expect(Object.keys(m)).toEqual([
      "board_version",
      "title",
      "measured_at",
      "measured_with",
      "complete",
      "not_found",
      "digest",
      "methods",
      "repos",
      "measures",
      "ratios",
      "trail",
      "integrity",
      "review_gaps",
    ]);
    expect(m).toMatchObject({
      board_version: 1,
      title: "Test board",
      measured_at: "2026-10-05T03:00:00.000Z",
      measured_with: WITH,
      measures: {
        src: { value: 4, unit: "lines", lane: "core" },
        test: { value: 2, unit: "lines" },
      },
    });
    expect(m.measures.test).not.toHaveProperty("lane");
  });

  it("gives the same digest at another time and a different one for another value", async () => {
    const declaration = declare(MEASURES.slice(0, 2));
    const first = await measure(declaration);
    const later = await measure(declaration, new Date("2026-10-06T00:00:00.000Z"));
    expect(later.measured_at).not.toBe(first.measured_at);
    expect(later.digest).toBe(first.digest);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(boardDigest(first)).toBe(first.digest);
    await writeFile(join(root, "app", "a.ts"), "1\n");
    expect((await measure(declaration)).digest).not.toBe(first.digest);
  });

  it("does not depend on the order of keys", () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } };
    const b = { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(boardDigest(a)).toBe(boardDigest(b));
    expect(boardDigest({ ...a, measured_at: "x", digest: "y" })).toBe(boardDigest(a));
  });
});

describe("measureBoard: what the review found", () => {
  const POSIX = process.platform !== "win32";
  const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;

  it("writes nothing under .basou/ when it counts tasks", async () => {
    await placeTask(TASK("T01"), "done");
    const index = join(paths.tasks, "index.json");
    const m = await measure(
      declare([{ id: "tasks", kind: "trail_count", of: "tasks", unit: "tasks" }]),
    );
    expect(m.measures.tasks?.value).toBe(1);
    await expect(stat(index)).rejects.toThrow();
  });

  it("does not fetch from the remote of a partial clone, and reports what it lacks", async () => {
    const origin = await repo("origin", { "src/f.txt": "1\n2\n" });
    git(origin, "config", "uploadpack.allowFilter", "true");
    await writeFile(join(origin, "src/f.txt"), "1\n2\n3\n");
    git(origin, "commit", "-q", "-am", "three lines");
    git(root, "clone", "-q", "--filter=blob:none", `file://${origin}`, "app");
    const app = join(root, "app");
    const old = git(app, "rev-parse", "main~1:src/f.txt").trim();
    const has = (oid: string) => {
      try {
        execFileSync("git", ["cat-file", "-e", oid], {
          cwd: app,
          env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" },
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    };
    expect(has(old)).toBe(false);
    const m = await measure(
      declare([
        {
          id: "old",
          kind: "line_count",
          repo: "app",
          include: ["src/f.txt"],
          at: "main~1",
          unit: "lines",
        },
      ]),
    );
    expect(has(old)).toBe(false);
    expect(m.measures.old?.value).toBeNull();
    expect(m.not_found[0]?.reason).toMatch(
      /^('src\/f\.txt' could not be read at 'main~1'|the repo 'app' \(at 'main~1'\) is a partial clone)/,
    );
  });

  it("reports a blob it cannot read at a revision instead of leaving it out", async () => {
    const dir = await repo("app", { "one.txt": "1\n2\n3\n", "two.txt": "1\n" });
    const oid = git(dir, "rev-parse", "main:one.txt").trim();
    await unlink(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    const m = await measure(
      declare([
        {
          id: "lines",
          kind: "line_count",
          repo: "app",
          include: ["*.txt"],
          at: "main",
          unit: "lines",
        },
      ]),
    );
    expect(m.not_found).toEqual([
      { at: "measures.lines", reason: "'one.txt' could not be read at 'main'" },
    ]);
  });

  it.skipIf(!POSIX || ROOT_USER)("reports a file, directory or repo it cannot read", async () => {
    const dir = await repo("app", { "src/a.ts": "1\n", "locked/b.ts": "1\n" });
    await mkdir(join(root, "sealed"));
    git(join(root, "sealed"), "init", "-q");
    await chmod(join(dir, "src/a.ts"), 0o000);
    await chmod(join(dir, "locked"), 0o000);
    await chmod(join(root, "sealed"), 0o000);
    try {
      const m = await measure(
        declare(
          [
            { id: "lines", kind: "line_count", repo: "app", include: ["src/*.ts"], unit: "lines" },
            {
              id: "files",
              kind: "file_count",
              repo: "app",
              include: ["locked/*.ts"],
              unit: "files",
            },
            { id: "sealed", kind: "file_count", repo: "sealed", include: ["*"], unit: "files" },
            { id: "fine", kind: "trail_count", of: "decisions_all", unit: "decisions" },
          ],
          {},
          ["app", "sealed"],
        ),
      );
      expect(m.measures.fine?.value).toBe(0);
      expect(m.not_found.map((n) => n.at)).toEqual([
        "measures.lines",
        "measures.files",
        "measures.sealed",
      ]);
      expect(m.not_found[0]?.reason).toBe("'src/a.ts' could not be read (EACCES)");
      expect(m.not_found[1]?.reason).toBe("'locked/b.ts' could not be read (EACCES)");
      expect(m.not_found[2]?.reason).toMatch(/^the repo 'sealed' /);
    } finally {
      await chmod(join(dir, "src/a.ts"), 0o644);
      await chmod(join(dir, "locked"), 0o755);
      await chmod(join(root, "sealed"), 0o755);
    }
  });

  it("matches an escaped include, normalizes a file path, and keeps '/' as a boundary", async () => {
    await repo("app", {
      "app/[slug]/page.tsx": "x\n",
      "docs/x.md": "a\nb\n",
      "library/a.ts": "x\n",
    });
    const m = await measure(
      declare([
        {
          id: "escaped",
          kind: "file_count",
          repo: "app",
          include: ["app/\\[slug\\]/*.tsx"],
          unit: "files",
        },
        {
          id: "literal",
          kind: "file_count",
          repo: "app",
          include: ["app/[slug]/page.tsx"],
          unit: "files",
        },
        {
          id: "dotted",
          kind: "regex_capture",
          repo: "app",
          file: "./docs/x.md",
          pattern: "^(b)",
          unit: "x",
        },
        {
          id: "doubled",
          kind: "json_length",
          repo: "app",
          file: "docs//x.md",
          pointer: "",
          unit: "x",
        },
        { id: "lib", kind: "file_count", repo: "app", include: ["lib/*.ts"], unit: "files" },
      ]),
    );
    expect(m.measures).toMatchObject({
      escaped: { value: 1 },
      literal: { value: 1 },
      dotted: { value: "b" },
      lib: { value: null },
    });
    expect(m.not_found).toEqual([
      { at: "measures.doubled", reason: "'docs//x.md' is not valid JSON in the working tree" },
      { at: "measures.lib", reason: "nothing is under 'lib' in the working tree" },
    ]);
  });

  it.skipIf(!POSIX)(
    "follows a link through a directory link at a revision, to inside or outside",
    async () => {
      const dir = await repo("app", { "real/f.txt": "1\n2\n3\n" });
      await mkdir(join(dir, "links"));
      await mkdir(join(root, "outdir"));
      await writeFile(join(root, "outdir", "o.txt"), "o\n");
      await symlink("../real", join(dir, "links/alias"));
      await symlink("alias/f.txt", join(dir, "links/via_alias.txt"));
      await symlink("../../outdir", join(dir, "links/outalias"));
      await symlink("outalias/o.txt", join(dir, "links/via_out.txt"));
      await symlink("..", join(dir, "links/root")); // the repository root: a directory, not a file
      await symlink("..", join(dir, "up")); // above the repository
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "links");
      const at = (id: string, include: string[]) => ({
        id,
        kind: "line_count",
        repo: "app",
        include,
        at: "main",
        unit: "lines",
      });
      const m = await measure(
        declare([
          at("via_alias", ["links/via_alias.txt"]),
          at("via_out", ["links/via_out.txt"]),
          at("up", ["u*"]),
          at("root", ["links/r*"]),
        ]),
      );
      expect(m.measures.via_alias?.value).toBe(3);
      expect(m.measures.root?.value).toBe(0);
      expect(m.not_found).toEqual([
        {
          at: "measures.via_out",
          reason: "'links/via_out.txt' is a symlink to outside the repository",
        },
        { at: "measures.up", reason: "'up' is a symlink to outside the repository" },
      ]);
    },
  );

  it("keeps two names that differ only in bytes that are not UTF-8 apart", async () => {
    const dir = await repo("app", { "keep.txt": "x\n" });
    const blob = (body: string) =>
      execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, env: GIT_ENV, input: body })
        .toString()
        .trim();
    const info = Buffer.concat([
      Buffer.from(`100644 ${blob("1\n")}\tn/bad`),
      Buffer.from([0xff]),
      Buffer.from(".txt\n"),
      Buffer.from(`100644 ${blob("1\n2\n")}\tn/bad`),
      Buffer.from([0xfe]),
      Buffer.from(".txt\n"),
    ]);
    execFileSync("git", ["update-index", "--add", "--index-info"], {
      cwd: dir,
      env: GIT_ENV,
      input: info,
    });
    git(dir, "commit", "-q", "-m", "odd names");
    const m = await measure(
      declare([
        {
          id: "files",
          kind: "file_count",
          repo: "app",
          include: ["n/*.txt"],
          at: "main",
          unit: "files",
        },
        {
          id: "lines",
          kind: "line_count",
          repo: "app",
          include: ["n/*.txt"],
          at: "main",
          unit: "lines",
        },
      ]),
    );
    expect(m.measures).toMatchObject({ files: { value: 2 }, lines: { value: 3 } });
  });

  it("does not count a submodule at a revision, or an unmerged path more than once", async () => {
    const dir = await repo("app", { "a.txt": "base\n" });
    const head = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
    git(dir, "commit", "-q", "-m", "submodule");
    git(dir, "checkout", "-q", "-b", "other");
    await writeFile(join(dir, "a.txt"), "other\n");
    git(dir, "commit", "-q", "-am", "other");
    git(dir, "checkout", "-q", "main");
    await writeFile(join(dir, "a.txt"), "main\n");
    git(dir, "commit", "-q", "-am", "main");
    expect(() => git(dir, "merge", "-q", "other")).toThrow();
    const m = await measure(
      declare([
        {
          id: "at_main",
          kind: "file_count",
          repo: "app",
          include: ["*"],
          at: "main",
          unit: "files",
        },
        { id: "conflicted", kind: "file_count", repo: "app", include: ["a.txt"], unit: "files" },
      ]),
    );
    expect(m.measures).toMatchObject({ at_main: { value: 1 }, conflicted: { value: 1 } });
  });

  it("counts a decision only when every event line was read, but not a torn last line", async () => {
    const s1 = SES("S01");
    const torn = line(s1, "E02", {
      type: "decision_recorded",
      decision_id: DEC("D02"),
      title: "b",
    }).slice(0, 30);
    await placeSession(
      s1,
      line(s1, "E01", { type: "decision_recorded", decision_id: DEC("D01"), title: "a" }) + torn,
    );
    const counts = [
      { id: "all", kind: "trail_count", of: "decisions_all", unit: "decisions" },
      { id: "tracks", kind: "trail_count", of: "tracks_open", unit: "tracks" },
    ];
    expect((await measure(declare(counts))).measures).toMatchObject({
      all: { value: 1 },
      tracks: { value: 0 },
    });
    const s2 = SES("S02");
    await placeSession(
      s2,
      `{"bad json\n${line(s2, "E03", { type: "decision_recorded", decision_id: DEC("D03"), title: "c" })}`,
    );
    const m = await measure(declare(counts));
    expect(m.measures).toMatchObject({ all: { value: null }, tracks: { value: null } });
    const lost = "1 event line could not be read, so decisions may be missing";
    expect(m.not_found).toEqual([
      { at: "measures.all", reason: lost },
      { at: "measures.tracks", reason: lost },
      { at: "trail", reason: lost },
      {
        at: "review_gaps",
        reason: "1 event line could not be read, so the counts are not known",
      },
    ]);
    expect(m.trail).toEqual({ decisions_all: null, decisions_live: null, tracks_open: null });
  });

  it("drops a leading BOM before matching lines", async () => {
    await repo("app", { "v.txt": "\uFEFFversion: 1.2\n" });
    const m = await measure(
      declare([
        {
          id: "v",
          kind: "regex_capture",
          repo: "app",
          file: "v.txt",
          pattern: "^version: (.*)$",
          unit: "x",
        },
      ]),
    );
    expect(m.measures.v?.value).toBe("1.2");
  });

  it("ignores a GIT_DIR in the environment", async () => {
    await repo("app", { "a.txt": "1\n", "b.txt": "1\n" });
    const other = await repo("other", { "z.txt": "1\n" });
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      const m = await measure(
        declare([
          {
            id: "n",
            kind: "file_count",
            repo: "app",
            include: ["*.txt"],
            at: "main",
            unit: "files",
          },
        ]),
      );
      expect(m.measures.n?.value).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  it("says when a revision names something that is not a commit", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    const tree = git(dir, "rev-parse", "main^{tree}").trim();
    const m = await measure(
      declare([
        { id: "n", kind: "file_count", repo: "app", include: ["*"], at: tree, unit: "files" },
      ]),
    );
    expect(m.not_found).toEqual([
      {
        at: "measures.n",
        reason: `the repo 'app' (at '${tree}') has '${tree}', but it is not a commit`,
      },
    ]);
  });
});

describe("measureBoard: the repos section", () => {
  const POSIX = process.platform !== "win32";
  const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;
  const VERSION = /(\d+)\.(\d+)/.exec(execFileSync("git", ["version"], { encoding: "utf8" }));
  const REFUSES_LAZY_FETCH =
    Number(VERSION?.[1]) > 2 || (Number(VERSION?.[1]) === 2 && Number(VERSION?.[2]) >= 44);
  const SSH_KEYGEN = (() => {
    try {
      execFileSync("sh", ["-c", "command -v ssh-keygen"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const SHALLOW = "the repo is a shallow clone, so its history is cut short";
  // Shell lines for a wrapped git: answer as a git older than 2.44, or as one
  // that does not know --is-shallow-repository and prints it back.
  const OLD_GIT =
    'for a in "$@"; do [ "$a" = version ] && { echo "git version 2.43.0"; exit 0; }; done';
  const NO_SHALLOW_OPTION =
    'for a in "$@"; do [ "$a" = --is-shallow-repository ] && { echo "$a"; exit 0; }; done';

  // Run `body` with a git first in PATH that runs `snippet` and then the real git.
  async function withWrappedGit(snippet: string, body: () => Promise<void>): Promise<void> {
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = join(root, "wrapped-git");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "git"), `#!/bin/sh\n${snippet}\nexec '${real}' "$@"\n`);
    await chmod(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    try {
      await body();
    } finally {
      process.env.PATH = saved;
    }
  }
  const NOTHING = {
    name: null,
    head: null,
    branch: null,
    last_commit: null,
    commits: null,
    files: null,
    uncommitted: null,
    behind_main: null,
  };

  // Measure a declaration with no measures, for a manifest that declares `repos`.
  function measureRepos(...repos: string[]): Promise<BoardMeasurement> {
    return measure(declare([], {}, repos), NOW, repos);
  }

  async function commit(
    dir: string,
    files: Record<string, string>,
    message: string,
    env: Record<string, string> = {},
  ): Promise<void> {
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), body);
    }
    git(dir, "add", "-A");
    execFileSync("git", ["commit", "-q", "-m", message], {
      cwd: dir,
      env: { ...GIT_ENV, ...env },
    });
  }

  function hasObject(dir: string, oid: string): boolean {
    try {
      execFileSync("git", ["cat-file", "-e", oid], {
        cwd: dir,
        env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" },
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  it("measures each repository the manifest declares, in its order", async () => {
    const upstream = await repo("upstream", { "a.txt": "1\n", ".gitignore": "dist/\n" });
    git(root, "clone", "-q", upstream, "app");
    const app = join(root, "app");
    git(app, "config", "user.email", "test@example.com");
    git(app, "config", "user.name", "test");
    await commit(upstream, { "b.txt": "1\n" }, "upstream moves on");
    await commit(upstream, { "b.txt": "2\n" }, "and on");
    git(app, "fetch", "-q");
    await commit(app, { "c.txt": "1\n" }, "local", {
      GIT_AUTHOR_DATE: "2026-09-01T00:00:00+00:00",
      GIT_COMMITTER_DATE: "2026-10-04T23:30:00+09:00",
    });
    await writeFile(join(app, "a.txt"), "changed\n");
    await mkdir(join(app, "notes"));
    await writeFile(join(app, "notes", "x.md"), "x\n");
    await writeFile(join(app, "notes", "y.md"), "y\n");
    await mkdir(join(app, "dist"));
    await writeFile(join(app, "dist", "out.js"), "ignored\n");
    const lib = await repo("lib", { "l.txt": "1\n" });

    const m = await measureRepos("lib", "app");
    expect(m.repos).toEqual([
      {
        path: "lib",
        name: "lib",
        head: git(lib, "rev-parse", "HEAD").trim(),
        branch: "main",
        last_commit: git(lib, "log", "-1", "--format=%cI").trim(),
        commits: 1,
        files: 1,
        uncommitted: 0,
        behind_main: null, // no origin/main
      },
      {
        path: "app",
        name: "app",
        head: git(app, "rev-parse", "HEAD").trim(),
        branch: "main",
        // The committer's time as git recorded it, not the author's, and not moved to UTC.
        last_commit: "2026-10-04T23:30:00+09:00",
        commits: 2,
        // .gitignore, a.txt, c.txt and the two untracked notes; dist/ is ignored.
        files: 5,
        // a.txt and the two notes.
        uncommitted: 3,
        // The two upstream commits, fetched but not merged (HEAD is one ahead).
        behind_main: 2,
      },
    ]);
    expect(Object.keys(m.repos[0] ?? {})).toEqual([
      "path",
      "name",
      "head",
      "branch",
      "last_commit",
      "commits",
      "files",
      "uncommitted",
      "behind_main",
    ]);
    expect(m.repos[0]?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(m.not_found).toEqual([]);
    expect(m.complete).toBe(true);
  });

  it("counts every commit reachable from HEAD, merges and all", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    git(dir, "checkout", "-q", "-b", "side");
    await commit(dir, { "s.txt": "1\n" }, "side");
    git(dir, "checkout", "-q", "main");
    await commit(dir, { "m.txt": "1\n" }, "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "side");
    const m = await measureRepos("app");
    expect(m.repos[0]?.commits).toBe(4);
  });

  it("counts the files a file_count of '**' counts", async () => {
    const dir = await repo(
      "app",
      { ".gitignore": "*.log\n", "a.txt": "1\n", "src/b.ts": "1\n", "old.txt": "1\n" },
      { "new.txt": "1\n", "x.log": "1\n" },
    );
    await unlink(join(dir, "old.txt"));
    const all = { id: "all", kind: "file_count", repo: "app", include: ["**"], unit: "files" };
    const m = await measure(declare([all]), NOW, ["app"]);
    // .gitignore, a.txt, src/b.ts and new.txt: not x.log, which is ignored, or old.txt, deleted.
    expect(m.repos[0]?.files).toBe(4);
    expect(m.measures.all?.value).toBe(4);
  });

  it.skipIf(!POSIX)(
    "refuses a symlink that leaves the repository as a file_count of '**' does",
    async () => {
      const dir = await repo("app", { "a.txt": "1\n" });
      await symlink("/", join(dir, "out.md"));
      const all = { id: "all", kind: "file_count", repo: "app", include: ["**"], unit: "files" };
      const m = await measure(declare([all]), NOW, ["app"]);
      expect(m.repos[0]?.files).toBeNull();
      expect(m.not_found).toEqual([
        { at: "repos[app].files", reason: "'out.md' is a symlink to outside the repository" },
        { at: "measures.all", reason: "'out.md' is a symlink to outside the repository" },
      ]);
    },
  );

  it("counts each path git status names, whatever git's settings say", async () => {
    const dir = await repo("app", {
      ".gitignore": "*.log\n",
      "a.txt": "a\n",
      "b.txt": "b\n",
      "c.txt": "c\n",
    });
    git(dir, "config", "status.renames", "true");
    git(dir, "config", "status.showUntrackedFiles", "no");
    git(dir, "mv", "a.txt", "moved.txt");
    await writeFile(join(dir, "b.txt"), "changed\n");
    await unlink(join(dir, "c.txt"));
    await mkdir(join(dir, "new"));
    for (const name of ["1.txt", "2.txt", "3.txt"]) await writeFile(join(dir, "new", name), "n\n");
    await writeFile(join(dir, "x.log"), "ignored\n");
    const m = await measureRepos("app");
    // a.txt and moved.txt, b.txt, c.txt, and each of the three files in new/.
    expect(m.repos[0]?.uncommitted).toBe(7);
  });

  it("leaves a stale index as it is, which git status would rewrite", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    const file = join(dir, "a.txt");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(file, old, old);
    git(dir, "update-index", "--refresh");
    const later = new Date("2026-10-01T00:00:00Z");
    await utimes(file, later, later);
    const index = join(dir, ".git", "index");
    const before = await readFile(index);
    const m = await measureRepos("app");
    expect(m.repos[0]?.uncommitted).toBe(0);
    expect((await readFile(index)).equals(before)).toBe(true);
    git(dir, "status", "--porcelain");
    expect((await readFile(index)).equals(before)).toBe(false);
  });

  it.skipIf(!POSIX)("does not run a file system monitor the repository configures", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    const marker = join(root, "monitor-ran");
    const hook = join(root, "monitor.sh");
    await writeFile(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
    await chmod(hook, 0o755);
    git(dir, "config", "core.fsmonitor", hook);
    const all = { id: "all", kind: "file_count", repo: "app", include: ["**"], unit: "files" };
    const m = await measure(declare([all]), NOW, ["app"]);
    expect(m.repos[0]).toMatchObject({ files: 1, uncommitted: 0 });
    await expect(stat(marker)).rejects.toThrow();
    git(dir, "status", "--porcelain");
    await expect(stat(marker)).resolves.toBeDefined();
  });

  it("gives a detached HEAD and a branch with no commit yet nulls with a meaning, not gaps", async () => {
    const detached = await repo("detached", { "a.txt": "1\n" });
    const first = git(detached, "rev-parse", "HEAD").trim();
    await commit(detached, { "b.txt": "1\n" }, "second");
    git(detached, "checkout", "-q", "--detach", first);
    const empty = join(root, "empty");
    await mkdir(empty);
    git(empty, "init", "-q", "-b", "main");
    await writeFile(join(empty, "staged.txt"), "1\n");
    git(empty, "add", "staged.txt");
    await writeFile(join(empty, "loose.txt"), "1\n");
    const orphan = await repo("orphan", { "a.txt": "1\n" });
    git(orphan, "checkout", "-q", "--orphan", "fresh");
    const m = await measureRepos("detached", "empty", "orphan");
    expect(m.repos).toEqual([
      {
        path: "detached",
        name: "detached",
        head: first,
        branch: null,
        last_commit: git(detached, "log", "-1", "--format=%cI").trim(),
        commits: 1,
        files: 1,
        uncommitted: 0,
        behind_main: null,
      },
      {
        path: "empty",
        name: "empty",
        head: null,
        branch: "main",
        last_commit: null,
        commits: 0,
        files: 2,
        uncommitted: 2,
        behind_main: null,
      },
      {
        path: "orphan",
        name: "orphan",
        head: null,
        branch: "fresh",
        last_commit: null,
        commits: 0,
        files: 1,
        uncommitted: 1,
        behind_main: null,
      },
    ]);
    expect(m.not_found).toEqual([]);
    expect(m.complete).toBe(true);
  });

  it("counts all of origin/main as behind when HEAD has no commit yet", async () => {
    const upstream = await repo("upstream", { "a.txt": "1\n" });
    await commit(upstream, { "b.txt": "1\n" }, "second");
    const empty = join(root, "empty");
    await mkdir(empty);
    git(empty, "init", "-q", "-b", "main");
    git(empty, "fetch", "-q", upstream, "main:refs/remotes/origin/main");
    const m = await measureRepos("empty");
    expect(m.repos[0]).toMatchObject({ head: null, commits: 0, behind_main: 2 });
    expect(m.complete).toBe(true);
  });

  it("reads origin/main as the remote-tracking ref, not a branch of that name", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    git(dir, "branch", "origin/main");
    const m = await measureRepos("app");
    expect(m.repos[0]?.behind_main).toBeNull();
    expect(m.not_found).toEqual([]);
  });

  it("reports a repo that is not there, not a repository, or not the root of one, once", async () => {
    await repo("app", { "sub/a.txt": "1\n" });
    await mkdir(join(root, "plain"));
    const repos = ["gone", "plain", "app/sub"];
    const gone = { id: "gone", kind: "file_count", repo: "gone", include: ["**"], unit: "files" };
    const m = await measure(declare([gone], {}, repos), NOW, repos);
    expect(m.repos).toEqual(repos.map((path) => ({ path, ...NOTHING })));
    expect(m.not_found).toEqual([
      { at: "repos[gone]", reason: "the repo 'gone' is not on disk" },
      { at: "repos[plain]", reason: "the repo 'plain' is not a git repository" },
      {
        at: "repos[app/sub]",
        reason: "the repo 'app/sub' is inside a git repository but is not its root",
      },
      { at: "measures.gone", reason: "the repo 'gone' is not on disk" },
    ]);
    expect(m.complete).toBe(false);
  });

  it("does not count the commits of a shallow clone", async () => {
    const upstream = await repo("upstream", { "a.txt": "1\n" });
    await commit(upstream, { "b.txt": "1\n" }, "second");
    await commit(upstream, { "c.txt": "1\n" }, "third");
    git(root, "clone", "-q", "--depth", "1", `file://${upstream}`, "app");
    const app = join(root, "app");
    const m = await measureRepos("app");
    expect(m.repos[0]).toEqual({
      path: "app",
      name: "app",
      head: git(app, "rev-parse", "HEAD").trim(),
      branch: "main",
      last_commit: git(app, "log", "-1", "--format=%cI").trim(),
      commits: null,
      files: 3,
      uncommitted: 0,
      behind_main: null,
    });
    const cut = "the repo is a shallow clone, so its history is cut short";
    expect(m.not_found).toEqual([
      { at: "repos[app].commits", reason: cut },
      { at: "repos[app].behind_main", reason: cut },
    ]);
  });

  it("says when origin/main is not a commit, and when HEAD names no commit", async () => {
    const odd = await repo("odd", { "a.txt": "1\n" });
    git(odd, "update-ref", "refs/remotes/origin/main", git(odd, "rev-parse", "HEAD^{tree}").trim());
    const broken = await repo("broken", { "a.txt": "1\n" });
    await writeFile(join(broken, ".git", "HEAD"), `${"1234567890".repeat(4)}\n`);
    const m = await measureRepos("odd", "broken");
    expect(m.repos[0]).toMatchObject({ commits: 1, behind_main: null });
    expect(m.repos[1]).toEqual({ path: "broken", ...NOTHING, name: "broken", files: 1 });
    const noCommit = "HEAD does not name a commit";
    expect(m.not_found).toEqual([
      { at: "repos[odd].behind_main", reason: "refs/remotes/origin/main is not a commit" },
      { at: "repos[broken].head", reason: noCommit },
      { at: "repos[broken].last_commit", reason: noCommit },
      { at: "repos[broken].commits", reason: noCommit },
      {
        at: "repos[broken].uncommitted",
        reason: "the working tree could not be compared by git",
      },
      { at: "repos[broken].behind_main", reason: noCommit },
    ]);
  });

  it.skipIf(!POSIX)("names a repository by the directory it is in after symlinks", async () => {
    await repo("app", { "a.txt": "1\n" });
    await symlink(join(root, "app"), join(root, "alias"));
    const m = await measureRepos("alias");
    expect(m.repos[0]).toMatchObject({ path: "alias", name: "app", files: 1 });
  });

  it("names its method's version, and puts the repos in the digest", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    const declaration = declare([], {}, ["app"]);
    const first = await measure(declaration, NOW, ["app"]);
    expect(first.methods).toEqual({ repos: 1, trail: 1, integrity: 1, review_gaps: 1 });
    const later = await measure(declaration, new Date("2026-10-06T00:00:00.000Z"), ["app"]);
    expect(later.digest).toBe(first.digest);
    await writeFile(join(dir, "b.txt"), "1\n");
    expect((await measure(declaration, NOW, ["app"])).digest).not.toBe(first.digest);
  });

  it("measures a partial clone without fetching what it lacks", async () => {
    const origin = await repo("origin", { "src/f.txt": "1\n2\n" });
    git(origin, "config", "uploadpack.allowFilter", "true");
    await writeFile(join(origin, "src/f.txt"), "1\n2\n3\n");
    git(origin, "commit", "-q", "-am", "three lines");
    git(root, "clone", "-q", "--filter=blob:none", `file://${origin}`, "app");
    const app = join(root, "app");
    const old = git(app, "rev-parse", "main~1:src/f.txt").trim();
    expect(hasObject(app, old)).toBe(false);
    await writeFile(join(app, "src/f.txt"), "changed\n");
    const m = await measureRepos("app");
    expect(hasObject(app, old)).toBe(false);
    expect(m.repos[0]).toMatchObject({ commits: 2, files: 1, behind_main: 0 });
    if (REFUSES_LAZY_FETCH) {
      expect(m.repos[0]?.uncommitted).toBe(1);
      expect(m.not_found).toEqual([]);
    } else {
      expect(m.repos[0]?.uncommitted).toBeNull();
      expect(m.not_found[0]?.reason).toMatch(/^the repo is a partial clone/);
    }
  });

  it.skipIf(!POSIX)(
    "does not compare the working tree of a partial clone with a git older than 2.44",
    async () => {
      const origin = await repo("origin", { "f.txt": "1\n" });
      git(origin, "config", "uploadpack.allowFilter", "true");
      git(root, "clone", "-q", "--filter=blob:none", `file://${origin}`, "app");
      const app = join(root, "app");
      await withWrappedGit(OLD_GIT, async () => {
        const m = await measureRepos("app");
        expect(m.repos[0]).toMatchObject({ commits: 1, files: 1, uncommitted: null });
        expect(m.not_found).toEqual([
          {
            at: "repos[app].uncommitted",
            reason:
              "the repo is a partial clone, which this git (older than 2.44) may fetch objects for from its remote",
          },
        ]);
        // Whether an object origin/main names is there is not asked either.
        git(
          app,
          "update-ref",
          "refs/remotes/origin/main",
          git(app, "rev-parse", "HEAD^{tree}").trim(),
        );
        const odd = await measureRepos("app");
        expect(odd.not_found).toContainEqual({
          at: "repos[app].behind_main",
          reason: "refs/remotes/origin/main is not a commit, or is not in the repository",
        });
      });
    },
  );

  it("is not complete when only a repo could not be measured", async () => {
    const m = await measureRepos("gone");
    expect(m.measures).toEqual({});
    expect(m.complete).toBe(false);
  });

  it.skipIf(!POSIX || ROOT_USER)(
    "does not count what may lie in a directory git could not open, and counts the rest",
    async () => {
      const dir = await repo("app", { "src/a.ts": "1\n", "src/lib/b.ts": "1\n" });
      const secret = join(dir, "secret");
      await mkdir(secret);
      await writeFile(join(secret, "one"), "version: 1\n");
      await chmod(secret, 0o000);
      try {
        const m = await measure(
          declare(
            [
              { id: "all", kind: "file_count", repo: "app", include: ["**"], unit: "files" },
              { id: "src", kind: "file_count", repo: "app", include: ["src/*.ts"], unit: "files" },
              { id: "inside", kind: "file_count", repo: "app", include: ["secret/*"], unit: "f" },
              {
                id: "capture",
                kind: "regex_capture",
                repo: "app",
                file: "secret/one",
                pattern: "^version: (.*)$",
                unit: "v",
              },
              { id: "src_dirs", kind: "dir_count", repo: "app", path: "src", depth: 1, unit: "d" },
              { id: "top_dirs", kind: "dir_count", repo: "app", path: ".", depth: 1, unit: "d" },
            ],
            {},
            ["app"],
          ),
          NOW,
          ["app"],
        );
        expect(m.repos[0]).toMatchObject({ files: null, uncommitted: null });
        expect(m.measures).toMatchObject({
          all: { value: null },
          src: { value: 1 },
          inside: { value: null },
          capture: { value: null },
          src_dirs: { value: 1 },
          top_dirs: { value: null },
        });
        const warned = `("could not open directory 'secret/': Permission denied")`;
        const listed = `git could not read all of the working tree ${warned}`;
        expect(m.not_found).toEqual([
          { at: "repos[app].files", reason: listed },
          {
            at: "repos[app].uncommitted",
            reason: `git could not compare all of the working tree ${warned}`,
          },
          { at: "measures.all", reason: listed },
          { at: "measures.inside", reason: listed },
          { at: "measures.capture", reason: listed },
          { at: "measures.top_dirs", reason: listed },
        ]);
        expect(m.complete).toBe(false);
      } finally {
        await chmod(secret, 0o755);
      }
    },
  );

  it.skipIf(!POSIX || ROOT_USER)(
    "does not count the files of a working tree whose ignore file git could not read",
    async () => {
      const dir = await repo(
        "app",
        { "a.txt": "1\n", "logs/.gitignore": "*.log\n" },
        { "logs/x.log": "1\n" },
      );
      await chmod(join(dir, "logs", ".gitignore"), 0o000);
      try {
        const m = await measure(
          declare(
            [
              { id: "logs", kind: "file_count", repo: "app", include: ["logs/*"], unit: "f" },
              { id: "txt", kind: "file_count", repo: "app", include: ["*.txt"], unit: "f" },
            ],
            {},
            ["app"],
          ),
          NOW,
          ["app"],
        );
        expect(m.repos[0]?.files).toBeNull();
        // Only what may lie under logs/ is in doubt.
        expect(m.measures).toMatchObject({ logs: { value: null }, txt: { value: 1 } });
        const unread = `git could not read all of the working tree ("unable to access 'logs/.gitignore': Permission denied")`;
        expect(m.not_found).toEqual([
          { at: "repos[app].files", reason: unread },
          {
            at: "repos[app].uncommitted",
            reason: `git could not compare all of the working tree ("unable to access 'logs/.gitignore': Permission denied")`,
          },
          { at: "measures.logs", reason: unread },
        ]);
      } finally {
        await chmod(join(dir, "logs", ".gitignore"), 0o644);
      }
    },
  );

  it.skipIf(!POSIX || ROOT_USER)(
    "does not count what a pattern may reach in a directory git could not open below it",
    async () => {
      const dir = await repo("app", { "src/a.ts": "1\n" });
      const hidden = join(dir, "src", "hidden");
      await mkdir(hidden);
      await writeFile(join(hidden, "b.ts"), "1\n");
      await chmod(hidden, 0o000);
      try {
        const deep = {
          id: "deep",
          kind: "file_count",
          repo: "app",
          include: ["src/**"],
          unit: "f",
        };
        const dirs = {
          id: "dirs",
          kind: "dir_count",
          repo: "app",
          path: "src",
          depth: 1,
          unit: "d",
        };
        const m = await measure(declare([deep, dirs]), NOW, ["app"]);
        expect(m.measures).toMatchObject({ deep: { value: null }, dirs: { value: null } });
        const reason = `git could not read all of the working tree ("could not open directory 'src/hidden/': Permission denied")`;
        expect(m.not_found).toContainEqual({ at: "measures.deep", reason });
        expect(m.not_found).toContainEqual({ at: "measures.dirs", reason });
      } finally {
        await chmod(hidden, 0o755);
      }
    },
  );

  it("does not take a ref under origin/main for it", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    git(dir, "update-ref", "refs/remotes/origin/main/x", "HEAD");
    const m = await measureRepos("app");
    expect(m.repos[0]?.behind_main).toBeNull();
    expect(m.not_found).toEqual([]);
  });

  it("does not take a tag or a branch named like origin/main for it", async () => {
    const tagged = await repo("tagged", { "a.txt": "1\n" });
    git(tagged, "tag", "refs/remotes/origin/main");
    const branched = await repo("branched", { "a.txt": "1\n" });
    git(branched, "branch", "refs/remotes/origin/main");
    const m = await measureRepos("tagged", "branched");
    expect(m.repos.map((r) => r.behind_main)).toEqual([null, null]);
    expect(m.not_found).toEqual([]);
  });

  it("does not take a tag named like an orphan branch for it", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    git(dir, "tag", "refs/heads/fresh");
    git(dir, "checkout", "-q", "--orphan", "fresh");
    const m = await measureRepos("app");
    expect(m.repos[0]).toMatchObject({ head: null, branch: "fresh", commits: 0 });
    expect(m.not_found).toEqual([]);
  });

  it("tells a broken origin/main, and one at an object that is not there, from a missing one", async () => {
    const broken = await repo("broken", { "a.txt": "1\n" });
    await mkdir(join(broken, ".git", "refs", "remotes", "origin"), { recursive: true });
    await writeFile(join(broken, ".git", "refs", "remotes", "origin", "main"), "garbage\n");
    const lost = await repo("lost", { "a.txt": "1\n" });
    await mkdir(join(lost, ".git", "refs", "remotes", "origin"), { recursive: true });
    await writeFile(
      join(lost, ".git", "refs", "remotes", "origin", "main"),
      `${"1234567890".repeat(4)}\n`,
    );
    const m = await measureRepos("broken", "lost");
    expect(m.repos.map((r) => r.behind_main)).toEqual([null, null]);
    expect(m.not_found).toEqual([
      { at: "repos[broken].behind_main", reason: "refs/remotes/origin/main is a broken ref" },
      {
        at: "repos[lost].behind_main",
        reason: "refs/remotes/origin/main points at an object that is not in the repository",
      },
    ]);
  });

  it("does not read a branch at an object that is not there as one with no commit yet", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    await writeFile(join(dir, ".git", "refs", "heads", "main"), `${"1234567890".repeat(4)}\n`);
    const m = await measureRepos("app");
    expect(m.repos[0]).toMatchObject({ head: null, branch: "main", commits: null });
    expect(m.not_found).toContainEqual({
      at: "repos[app].head",
      reason: "HEAD does not name a commit",
    });
    expect(m.not_found).toContainEqual({
      at: "repos[app].commits",
      reason: "HEAD does not name a commit",
    });
  });

  it("does not read a HEAD git cannot resolve as a detached one", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/a..b\n");
    const m = await measureRepos("app");
    expect(m.repos[0]?.branch).toBeNull();
    expect(m.not_found).toContainEqual({
      at: "repos[app].branch",
      reason: "HEAD could not be read",
    });
  });

  it("does not count the files of a working tree whose index is broken", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    await writeFile(join(dir, ".git", "index"), "garbage");
    const m = await measureRepos("app");
    expect(m.repos[0]).toMatchObject({ files: null, uncommitted: null });
    expect(m.not_found).toContainEqual({
      at: "repos[app].files",
      reason: "the working tree could not be listed by git",
    });
  });

  it("keeps a branch name with a slash or a letter outside ASCII as it is", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    const name = "feature/caf\u00e9";
    git(dir, "checkout", "-q", "-b", name);
    const m = await measureRepos("app");
    expect(m.repos[0]?.branch).toBe(name);
  });

  it("does not give a branch name that is not valid UTF-8", async () => {
    const dir = await repo("app", { "a.txt": "1\n" });
    const head = git(dir, "rev-parse", "HEAD").trim();
    const name = Buffer.concat([
      Buffer.from("refs/heads/x"),
      Buffer.from([0xff]),
      Buffer.from("y"),
    ]);
    await writeFile(
      join(dir, ".git", "packed-refs"),
      Buffer.concat([Buffer.from(`${head} `), name, Buffer.from("\n")]),
    );
    await writeFile(
      join(dir, ".git", "HEAD"),
      Buffer.concat([Buffer.from("ref: "), name, Buffer.from("\n")]),
    );
    const m = await measureRepos("app");
    expect(m.repos[0]).toMatchObject({ head, branch: null, commits: 1 });
    expect(m.not_found).toEqual([
      { at: "repos[app].branch", reason: "the name of HEAD's branch is not valid UTF-8" },
    ]);
  });

  it("counts no commit for a shallow repository with no commit yet", async () => {
    const upstream = await repo("upstream", { "a.txt": "1\n" });
    await commit(upstream, { "b.txt": "1\n" }, "second");
    const empty = join(root, "empty");
    await mkdir(empty);
    git(empty, "init", "-q", "-b", "main");
    git(
      empty,
      "fetch",
      "-q",
      "--depth",
      "1",
      `file://${upstream}`,
      "main:refs/remotes/origin/main",
    );
    const m = await measureRepos("empty");
    expect(m.repos[0]).toMatchObject({ head: null, commits: 0, behind_main: null });
    expect(m.not_found).toEqual([{ at: "repos[empty].behind_main", reason: SHALLOW }]);
  });

  it.skipIf(!POSIX)(
    "does not compare a repo with a submodule with a git older than 2.44",
    async () => {
      const dir = await repo("app", { "a.txt": "1\n" });
      const head = git(dir, "rev-parse", "HEAD").trim();
      git(dir, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
      git(dir, "commit", "-q", "-m", "submodule");
      await withWrappedGit(OLD_GIT, async () => {
        const m = await measureRepos("app");
        expect(m.repos[0]?.uncommitted).toBeNull();
        expect(m.not_found).toEqual([
          {
            at: "repos[app].uncommitted",
            reason:
              "the repo has a submodule, which git status looks into, and this git (older than 2.44) may fetch objects for it from its remote",
          },
        ]);
      });
      if (REFUSES_LAZY_FETCH) {
        expect((await measureRepos("app")).repos[0]?.uncommitted).toEqual(expect.any(Number));
      }
    },
  );

  it.skipIf(!POSIX)(
    "does not count commits when git cannot say whether the history is cut short",
    async () => {
      await repo("app", { "a.txt": "1\n" });
      await withWrappedGit(NO_SHALLOW_OPTION, async () => {
        const m = await measureRepos("app");
        expect(m.repos[0]).toMatchObject({ commits: null, behind_main: null, files: 1 });
        const unknown = "could not tell whether the history of the repo is complete";
        expect(m.not_found).toEqual([
          { at: "repos[app].commits", reason: unknown },
          { at: "repos[app].behind_main", reason: unknown },
        ]);
      });
    },
  );

  it.skipIf(!POSIX || !SSH_KEYGEN)(
    "reads the time of a signed commit without its signature",
    async () => {
      const dir = await repo("app", { "a.txt": "1\n" });
      const key = join(root, "key");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key]);
      const pub = (await readFile(`${key}.pub`, "utf8")).trim();
      await writeFile(join(root, "allowed"), `test@example.com ${pub}\n`);
      git(dir, "config", "gpg.format", "ssh");
      git(dir, "config", "user.signingkey", key);
      git(dir, "config", "gpg.ssh.allowedSignersFile", join(root, "allowed"));
      execFileSync("git", ["commit", "-q", "--allow-empty", "-S", "-m", "signed"], {
        cwd: dir,
        env: { ...GIT_ENV, GIT_COMMITTER_DATE: "2026-10-04T23:30:00+09:00" },
      });
      git(dir, "config", "log.showSignature", "true");
      // What the date would read with the signature in the way.
      expect(git(dir, "log", "-1", "--format=%cI")).toContain("Good");
      const m = await measureRepos("app");
      expect(m.repos[0]?.last_commit).toBe("2026-10-04T23:30:00+09:00");
    },
  );

  it("counts every commit origin/main has that HEAD does not, merges and all", async () => {
    const upstream = await repo("upstream", { "a.txt": "1\n" });
    git(root, "clone", "-q", upstream, "app");
    git(upstream, "checkout", "-q", "-b", "side");
    await commit(upstream, { "s.txt": "1\n" }, "side");
    git(upstream, "checkout", "-q", "main");
    await commit(upstream, { "m.txt": "1\n" }, "main");
    git(upstream, "merge", "-q", "--no-ff", "-m", "merge", "side");
    git(join(root, "app"), "fetch", "-q");
    const m = await measureRepos("app");
    expect(m.repos[0]?.behind_main).toBe(3);
  });

  it("ignores a GIT_DIR in the environment", async () => {
    const app = await repo("app", { "a.txt": "1\n" });
    const other = await repo("other", { "z.txt": "1\n" });
    await commit(other, { "y.txt": "1\n" }, "second");
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      const m = await measureRepos("app");
      expect(m.repos[0]).toMatchObject({
        head: git(app, "rev-parse", "HEAD").trim(),
        commits: 1,
        files: 1,
      });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

describe("measureBoard: the trail section", () => {
  const decided = (
    sessionId: string,
    evt: string,
    id: string,
    title: string,
    occurredAt: string,
    kind?: "decision" | "track",
  ): string =>
    line(sessionId, evt, {
      type: "decision_recorded",
      decision_id: id,
      title,
      occurred_at: occurredAt,
      ...(kind === undefined ? {} : { kind }),
    });

  it("lists the open tracks newest first, then by id, with their titles as recorded", async () => {
    const s1 = SES("S01");
    const s2 = SES("S02");
    await placeSession(
      s1,
      decided(s1, "E01", DEC("D01"), "  oldest, with spaces  ", "2026-09-01T00:00:00Z", "track") +
        decided(s1, "E02", DEC("D02"), "a decision", "2026-09-05T00:00:00Z") +
        decided(s1, "E03", DEC("D03"), "same time, lower id", "2026-09-10T00:00:00Z", "track"),
    );
    await placeSession(
      s2,
      decided(s2, "E04", DEC("D04"), "same time, higher id", "2026-09-10T00:00:00Z", "track") +
        decided(s2, "E05", DEC("D05"), "voided", "2026-09-20T00:00:00Z", "track") +
        line(s2, "E06", { type: "decision_voided", decision_id: DEC("D05") }),
    );
    const m = await measure(declare([]));
    expect(m.trail).toEqual({
      decisions_all: 5,
      decisions_live: 4,
      tracks_open: [
        { id: DEC("D04"), title: "same time, higher id" },
        { id: DEC("D03"), title: "same time, lower id" },
        { id: DEC("D01"), title: "  oldest, with spaces  " },
      ],
    });
    expect(m.complete).toBe(true);
  });

  it("counts a decision recorded twice under one id once, by its earliest record", async () => {
    // The earliest record is neither the first nor the last one read.
    const [s1, s2, s3] = [SES("S01"), SES("S02"), SES("S03")];
    await placeSession(
      s1,
      decided(s1, "E01", DEC("D01"), "middle", "2026-09-02T00:00:00Z", "track"),
    );
    await placeSession(
      s2,
      decided(s2, "E02", DEC("D01"), "first", "2026-09-01T00:00:00Z", "track"),
    );
    await placeSession(s3, decided(s3, "E03", DEC("D01"), "last", "2026-09-03T00:00:00Z", "track"));
    const counts = [
      { id: "all", kind: "trail_count", of: "decisions_all", unit: "decisions" },
      { id: "live", kind: "trail_count", of: "decisions_live", unit: "decisions" },
      { id: "tracks", kind: "trail_count", of: "tracks_open", unit: "tracks" },
    ];
    const m = await measure(declare(counts));
    expect(m.trail).toEqual({
      decisions_all: 1,
      decisions_live: 1,
      tracks_open: [{ id: DEC("D01"), title: "first" }],
    });
    expect(m.measures).toMatchObject({
      all: { value: 1 },
      live: { value: 1 },
      tracks: { value: 1 },
    });
  });

  it("closes a track voided before it was recorded", async () => {
    const s1 = SES("S01");
    const s2 = SES("S02");
    await placeSession(s1, line(s1, "E01", { type: "decision_voided", decision_id: DEC("D01") }));
    await placeSession(s2, decided(s2, "E02", DEC("D01"), "t", "2026-09-01T00:00:00Z", "track"));
    const m = await measure(declare([]));
    expect(m.trail).toEqual({ decisions_all: 1, decisions_live: 0, tracks_open: [] });
  });

  it("orders the tracks by instant, whatever offset each time is written with", async () => {
    const s1 = SES("S01");
    await placeSession(
      s1,
      // 09:00+09:00 is 00:00Z, an hour before 01:00Z, though it sorts after it as text.
      decided(s1, "E01", DEC("D01"), "earlier", "2026-09-10T09:00:00+09:00", "track") +
        decided(s1, "E02", DEC("D02"), "later", "2026-09-10T01:00:00.500Z", "track"),
    );
    const m = await measure(declare([]));
    expect(m.trail.tracks_open?.map((t) => t.title)).toEqual(["later", "earlier"]);
  });

  it("takes whether a decision is a track from its earliest record too", async () => {
    const [s1, s2] = [SES("S01"), SES("S02")];
    await placeSession(
      s1,
      decided(s1, "E01", DEC("D01"), "a decision first", "2026-09-01T00:00:00Z", "decision") +
        decided(s1, "E02", DEC("D02"), "a track first", "2026-09-01T00:00:00Z", "track"),
    );
    await placeSession(
      s2,
      decided(s2, "E03", DEC("D01"), "then a track", "2026-09-02T00:00:00Z", "track") +
        decided(s2, "E04", DEC("D02"), "then a decision", "2026-09-02T00:00:00Z", "decision"),
    );
    const m = await measure(declare([]));
    expect(m.trail.tracks_open).toEqual([{ id: DEC("D02"), title: "a track first" }]);
  });

  it("does not let a void of a decision never recorded take a live one away", async () => {
    const s1 = SES("S01");
    await placeSession(
      s1,
      decided(s1, "E01", DEC("D01"), "kept", "2026-09-01T00:00:00Z") +
        line(s1, "E02", { type: "decision_voided", decision_id: DEC("D99") }),
    );
    const m = await measure(declare([]));
    expect(m.trail).toMatchObject({ decisions_all: 1, decisions_live: 1 });
  });

  it("is not measured when a complete line is not an event, even as the last line", async () => {
    const s1 = SES("S01");
    const good = decided(s1, "E01", DEC("D01"), "a", "2026-09-01T00:00:00Z");
    // Complete JSON, but not an event of the schema: not a write in progress.
    const off = line(s1, "E02", {
      type: "decision_recorded",
      decision_id: DEC("D02"),
      title: "b",
      kind: "plan",
    }).trimEnd();
    await placeSession(s1, good + off);
    const m = await measure(declare([]));
    expect(m.trail).toEqual({ decisions_all: null, decisions_live: null, tracks_open: null });
    expect(m.not_found).toEqual([
      { at: "trail", reason: "1 event line could not be read, so decisions may be missing" },
      {
        at: "review_gaps",
        reason: "1 event line could not be read, so the counts are not known",
      },
    ]);
    expect(m.complete).toBe(false);
  });

  it("counts every line that is not JSON but a torn last one", async () => {
    const [s1, s2, s3] = [SES("S01"), SES("S02"), SES("S03")];
    const ok = (sessionId: string, evt: string, id: string) =>
      decided(sessionId, evt, id, "t", "2026-09-01T00:00:00Z");
    // Torn: the last line, with no newline after it.
    await placeSession(s1, `${ok(s1, "E01", DEC("D01"))}{"torn`);
    const torn = await measure(declare([]));
    expect(torn.trail.decisions_all).toBe(1);
    expect(torn.review_gaps.gaps).toBe(0);
    // Not torn: a last line that is not JSON but ends with a newline.
    await placeSession(s2, `${ok(s2, "E02", DEC("D02"))}{"ended\n`);
    // Not torn: not the last line, in a file that does not end with a newline.
    await placeSession(s3, `{"early\n${ok(s3, "E03", DEC("D03")).trimEnd()}`);
    const m = await measure(declare([]));
    expect(m.not_found).toEqual([
      { at: "trail", reason: "2 event lines could not be read, so decisions may be missing" },
      {
        at: "review_gaps",
        reason: "2 event lines could not be read, so the counts are not known",
      },
    ]);
  });

  it("counts many lines that are not JSON, each once", async () => {
    const s1 = SES("S01");
    await placeSession(s1, `${'{"bad\n'.repeat(3000)}{"torn`);
    const m = await measure(declare([]));
    expect(m.not_found).toEqual([
      { at: "trail", reason: "3000 event lines could not be read, so decisions may be missing" },
      {
        at: "review_gaps",
        reason: "3000 event lines could not be read, so the counts are not known",
      },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "is not measured when an entry named as a session is not a directory",
    async () => {
      const s1 = SES("S01");
      await placeSession(s1, decided(s1, "E01", DEC("D01"), "t", "2026-09-01T00:00:00Z", "track"));
      await symlink(join(paths.sessions, s1), join(paths.sessions, SES("S02")));
      await writeFile(join(paths.sessions, SES("S03")), "not a session\n");
      const m = await measure(declare([]));
      expect(m.trail).toEqual({ decisions_all: null, decisions_live: null, tracks_open: null });
      expect(m.not_found).toEqual([
        {
          at: "trail",
          reason:
            "2 session entries are not a directory (a symlink or a file), so decisions may be missing",
        },
        {
          at: "review_gaps",
          reason:
            "2 session entries are not a directory (a symlink or a file), so the counts are not known",
        },
      ]);
    },
  );

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )("is not measured when the sessions cannot be listed", async () => {
    await chmod(paths.sessions, 0o000);
    try {
      const m = await measure(declare([]));
      expect(m.trail).toEqual({ decisions_all: null, decisions_live: null, tracks_open: null });
      expect(m.not_found).toEqual([
        { at: "trail", reason: "the sessions of the workspace could not be read" },
        { at: "integrity", reason: "the sessions of the workspace could not be read" },
        { at: "review_gaps", reason: "the sessions of the workspace could not be read" },
      ]);
    } finally {
      await chmod(paths.sessions, 0o755);
    }
  });

  it("reads the decisions once for the section and every measure", async () => {
    const s1 = SES("S01");
    await placeSession(s1, `{"bad\n${decided(s1, "E01", DEC("D01"), "t", "2026-09-01T00:00:00Z")}`);
    const warned: number[] = [];
    await measureBoard({
      declaration: declare([
        { id: "all", kind: "trail_count", of: "decisions_all", unit: "decisions" },
        { id: "live", kind: "trail_count", of: "decisions_live", unit: "decisions" },
      ]),
      root,
      repos: [],
      paths,
      now: NOW,
      measuredWith: WITH,
      onReplayWarning: (warning) => warned.push(warning.line),
    });
    expect(warned).toEqual([1]);
  });

  it("is in the digest", async () => {
    const declaration = declare([]);
    const first = await measure(declaration);
    const s1 = SES("S01");
    await placeSession(s1, decided(s1, "E01", DEC("D01"), "t", "2026-09-01T00:00:00Z", "track"));
    expect((await measure(declaration)).digest).not.toBe(first.digest);
  });

  it("does not read the tasks unless a measure counts them", async () => {
    await writeFile(join(paths.tasks, `${TASK("T01")}.md`), "not a task\n");
    const skipped: string[] = [];
    const run = (measures: Record<string, unknown>[]) =>
      measureBoard({
        declaration: declare(measures),
        root,
        repos: [],
        paths,
        now: NOW,
        measuredWith: WITH,
        onTaskSkip: (taskId) => skipped.push(taskId),
      });
    const quiet = await run([]);
    expect(skipped).toEqual([]);
    expect(quiet.complete).toBe(true);
    const counted = await run([{ id: "tasks", kind: "trail_count", of: "tasks", unit: "tasks" }]);
    expect(skipped).toEqual([TASK("T01")]);
    expect(counted.not_found).toEqual([
      { at: "measures.tasks", reason: "1 task could not be read" },
    ]);
  });
});

describe("measureBoard: the integrity section", () => {
  // A session whose events are chained, with session.yaml at `status` and the
  // head anchor (`anchor: false` leaves it out, a number writes a wrong
  // count), or no session.yaml at all.
  async function placeChained(
    id: string,
    options: { status?: string; anchor?: boolean | number; yaml?: boolean; version?: string } = {},
  ): Promise<void> {
    const dir = join(paths.sessions, id);
    await mkdir(dir, { recursive: true });
    const events = ["E01", "E02"].map(
      (evt) => JSON.parse(line(id, evt, { type: "note_added", body: evt })) as Event,
    );
    const { lines, headHash, count } = chainEvents(events, id);
    await writeFile(join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
    if (options.yaml === false) return;
    const anchor = options.anchor ?? true;
    await writeFile(
      join(dir, "session.yaml"),
      stringify({
        schema_version: options.version ?? "0.1.0",
        session: {
          id,
          label: "fixture",
          task_id: null,
          workspace_id: WS,
          source: { kind: "terminal", version: "0.1.0" },
          started_at: "2026-10-01T00:00:00Z",
          status: options.status ?? "completed",
          working_directory: "/tmp/fixture",
          invocation: { command: "echo", args: [], exit_code: 0 },
          related_files: [],
          events_log: "events.jsonl",
          ...(anchor === false
            ? {}
            : {
                integrity: {
                  head_hash: headHash,
                  event_count: typeof anchor === "number" ? anchor : count,
                },
              }),
        },
      }),
    );
  }

  it("counts the sessions of each status basou verify gives, every status included", async () => {
    await placeChained(SES("S01"));
    await placeChained(SES("S02"));
    await placeSession(SES("S03"), line(SES("S03"), "E01", { type: "note_added", body: "x" }));
    const m = await measure(declare([]));
    expect(m.integrity).toEqual({
      by_status: {
        verified: 2,
        unchained: 1,
        empty: 0,
        incomplete: 0,
        in_progress: 0,
        unsupported: 0,
        tampered: 0,
      },
      not_verified: 1,
    });
    expect(Object.keys(m.integrity.by_status ?? {})).toEqual([
      "verified",
      "unchained",
      "empty",
      "incomplete",
      "in_progress",
      "unsupported",
      "tampered",
    ]);
    expect(m.complete).toBe(true);
  });

  it("counts every status but verified as not verified", async () => {
    await placeChained(SES("S01"));
    await placeSession(SES("S02"), line(SES("S02"), "E01", { type: "note_added", body: "x" }));
    await placeSession(SES("S03"), "");
    await placeChained(SES("S04"), { yaml: false });
    await placeChained(SES("S05"), { status: "running", anchor: false });
    await placeChained(SES("S06"), { version: "1.0.0" });
    await placeChained(SES("S07"), { anchor: 5 });
    await placeChained(SES("S08"), { anchor: 7 });
    const m = await measure(declare([]));
    expect(m.integrity).toEqual({
      by_status: {
        verified: 1,
        unchained: 1,
        empty: 1,
        incomplete: 1,
        in_progress: 1,
        unsupported: 1,
        tampered: 2,
      },
      not_verified: 7,
    });
    // basou verify judges a session with no session.yaml (incomplete) and one
    // of a version it does not know (unsupported); basou review-gaps passes
    // over both, so it is the review gaps that are not known.
    expect(m.not_found).toEqual([
      { at: "review_gaps", reason: "2 sessions could not be read, so the counts are not known" },
    ]);
  });

  it("counts nothing, all at 0, in a workspace with no session", async () => {
    const m = await measure(declare([]));
    expect(m.integrity.by_status).toEqual({
      verified: 0,
      unchained: 0,
      empty: 0,
      incomplete: 0,
      in_progress: 0,
      unsupported: 0,
      tampered: 0,
    });
    expect(m.integrity.not_verified).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "counts an entry named as a session that is not a directory as tampered, as basou verify does",
    async () => {
      await placeChained(SES("S01"));
      await symlink(join(paths.sessions, SES("S01")), join(paths.sessions, SES("S02")));
      await writeFile(join(paths.sessions, SES("S03")), "not a session\n");
      const m = await measure(declare([]));
      expect(m.integrity).toMatchObject({
        by_status: { verified: 1, tampered: 2 },
        not_verified: 2,
      });
      expect(m.not_found.filter((n) => n.at === "integrity")).toEqual([]);
    },
  );

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )("is not measured when a session cannot be read, however many could", async () => {
    await placeChained(SES("S01"));
    await placeChained(SES("S02"));
    await placeChained(SES("S03"));
    // session.yaml, which basou verify reads and the trail does not.
    const shut = [SES("S01"), SES("S03")].map((id) => join(paths.sessions, id, "session.yaml"));
    for (const file of shut) await chmod(file, 0o000);
    try {
      const m = await measure(declare([]));
      expect(m.integrity).toEqual({ by_status: null, not_verified: null });
      const two = "2 sessions could not be read, so the counts are not known";
      expect(m.not_found).toEqual([
        { at: "integrity", reason: two },
        { at: "review_gaps", reason: two },
      ]);
      expect(m.complete).toBe(false);
      await chmod(shut[0] as string, 0o644);
      const one = "1 session could not be read, so the counts are not known";
      expect((await measure(declare([]))).not_found).toEqual([
        { at: "integrity", reason: one },
        { at: "review_gaps", reason: one },
      ]);
    } finally {
      for (const file of shut) await chmod(file, 0o644);
    }
  });

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )("is not measured when the sessions cannot be listed", async () => {
    await chmod(paths.sessions, 0o000);
    try {
      const m = await measure(declare([]));
      expect(m.integrity).toEqual({ by_status: null, not_verified: null });
      expect(m.not_found).toContainEqual({
        at: "integrity",
        reason: "the sessions of the workspace could not be read",
      });
    } finally {
      await chmod(paths.sessions, 0o755);
    }
  });

  it.skipIf(process.platform === "win32")(
    "says the sessions directory was refused, in the trail too, when it is a symlink or a file",
    async () => {
      const elsewhere = join(root, "elsewhere");
      await mkdir(elsewhere);
      await rm(paths.sessions, { recursive: true });
      await symlink(elsewhere, paths.sessions);
      const linked = await measure(declare([]));
      expect(linked.integrity).toEqual({ by_status: null, not_verified: null });
      expect(linked.trail).toEqual({
        decisions_all: null,
        decisions_live: null,
        tracks_open: null,
      });
      const refused = ".basou/sessions is a symlink, which basou refuses to read";
      expect(linked.not_found).toEqual([
        { at: "trail", reason: refused },
        { at: "integrity", reason: refused },
        { at: "review_gaps", reason: refused },
      ]);
      await unlink(paths.sessions);
      await writeFile(paths.sessions, "not a directory\n");
      const file = await measure(declare([]));
      expect(file.integrity).toEqual({ by_status: null, not_verified: null });
      expect(file.not_found).toEqual([
        { at: "trail", reason: ".basou/sessions is not a directory" },
        { at: "integrity", reason: ".basou/sessions is not a directory" },
        { at: "review_gaps", reason: ".basou/sessions is not a directory" },
      ]);
    },
  );

  it("counts nothing when there is no sessions directory", async () => {
    await rm(paths.sessions, { recursive: true });
    const m = await measure(declare([]));
    expect(m.integrity.not_verified).toBe(0);
    expect(m.trail.decisions_all).toBe(0);
    expect(m.complete).toBe(true);
  });

  it("names its method's version, and is in the digest", async () => {
    const declaration = declare([]);
    const first = await measure(declaration);
    expect(first.methods).toEqual({ repos: 1, trail: 1, integrity: 1, review_gaps: 1 });
    await placeChained(SES("S01"));
    const verified = await measure(declaration);
    await rm(join(paths.sessions, SES("S01")), { recursive: true });
    await placeChained(SES("S01"), { anchor: 9 });
    const tampered = await measure(declaration);
    // The trail is the same in all three; only the integrity differs.
    expect(tampered.trail).toEqual(verified.trail);
    expect(new Set([first.digest, verified.digest, tampered.digest]).size).toBe(3);
  });
});

describe("measureBoard: the review_gaps section", () => {
  // Absent on disk, so basou review-gaps keys them by the path as recorded.
  const ALPHA = "/nonexistent/projects/alpha";
  const BETA = "/nonexistent/projects/beta";
  const GAMMA = "/nonexistent/projects/gamma";
  const DELTA = "/nonexistent/projects/delta";

  // A session whose source is `source` (basou review-gaps reads a
  // codex-import session as a review, any other as the work), with `events`.
  async function placeWork(
    id: string,
    source: string,
    events: string,
    status = "imported",
  ): Promise<void> {
    const dir = join(paths.sessions, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "session.yaml"),
      stringify({
        schema_version: "0.1.0",
        session: {
          id,
          label: "fixture",
          task_id: null,
          workspace_id: WS,
          source: { kind: source, version: "0.1.0" },
          started_at: "2026-10-01T00:00:00Z",
          status,
          working_directory: "/tmp/fixture",
          invocation: { command: source, args: [], exit_code: null },
          related_files: [],
          events_log: "events.jsonl",
        },
      }),
    );
    await writeFile(join(dir, "events.jsonl"), events);
  }

  const ran = (
    sessionId: string,
    evt: string,
    occurredAt: string,
    script: string,
    cwd: string | null,
  ): string =>
    line(sessionId, evt, {
      type: "command_executed",
      occurred_at: occurredAt,
      command: null,
      args: ["-c", script],
      cwd,
      exit_code: 0,
      duration_ms: 0,
    });

  it("counts the units of each verdict basou review-gaps gives, every verdict included, and the gaps", async () => {
    const [r1, r2, c1, c2, c3, c4] = ["R01", "R02", "C01", "C02", "C03", "C04"].map(SES);
    const before = "2026-10-01T09:30:00Z";
    const after = "2026-10-01T10:05:00Z";
    // A review that examined the diff of alpha, and one that only read a file of beta.
    await placeWork(
      r1 as string,
      "codex-import",
      ran(r1 as string, "E01", before, "git diff", ALPHA),
    );
    await placeWork(
      r2 as string,
      "codex-import",
      ran(r2 as string, "E02", before, "sed -n '1,5p' NOTES.md", BETA),
    );
    await placeWork(
      c1 as string,
      "claude-code-import",
      ran(c1 as string, "E03", after, "git commit -m a", ALPHA),
    );
    await placeWork(
      c2 as string,
      "claude-code-import",
      ran(c2 as string, "E04", after, "git add src/app.ts && git commit -m b", BETA),
    );
    // No review at all, in two repositories: two units of one session.
    await placeWork(
      c3 as string,
      "claude-code-import",
      ran(c3 as string, "E05", after, "git commit -m c", GAMMA) +
        ran(c3 as string, "E06", after, "git commit -m d", DELTA),
    );
    // Where it ran was not recorded, so no repository can be named.
    await placeWork(
      c4 as string,
      "claude-code-import",
      ran(c4 as string, "E07", after, "git commit -m e", null),
    );
    const m = await measure(declare([]));
    expect(m.review_gaps).toEqual({
      by_verdict: { omission: 2, near_unbound: 1, candidate: 1, unknown: 1 },
      gaps: 3,
    });
    expect(Object.keys(m.review_gaps.by_verdict ?? {})).toEqual([
      "omission",
      "near_unbound",
      "candidate",
      "unknown",
    ]);
    expect(m.complete).toBe(true);
  });

  it("counts nothing, all at 0, in a workspace with no session or no sessions directory", async () => {
    const zero = {
      by_verdict: { omission: 0, near_unbound: 0, candidate: 0, unknown: 0 },
      gaps: 0,
    };
    expect((await measure(declare([]))).review_gaps).toEqual(zero);
    await rm(paths.sessions, { recursive: true });
    const m = await measure(declare([]));
    expect(m.review_gaps).toEqual(zero);
    expect(m.complete).toBe(true);
  });

  it("does not count a commit on a torn last line, and is measured", async () => {
    const s1 = SES("C01");
    const landed = ran(s1, "E01", "2026-10-01T10:05:00Z", "git commit -m a", ALPHA);
    const torn = ran(s1, "E02", "2026-10-01T10:06:00Z", "git commit -m b", BETA).slice(0, 40);
    await placeWork(s1, "claude-code-import", landed + torn);
    const m = await measure(declare([]));
    expect(m.review_gaps).toEqual({
      by_verdict: { omission: 1, near_unbound: 0, candidate: 0, unknown: 0 },
      gaps: 1,
    });
    expect(m.complete).toBe(true);
  });

  it("counts a line once, though the events of a running session are read twice", async () => {
    const s1 = SES("C01");
    await placeWork(
      s1,
      "claude-code-import",
      `{"bad\n${ran(s1, "E01", "2026-10-01T10:05:00Z", "git commit -m a", ALPHA)}`,
      "running",
    );
    const m = await measure(declare([]));
    expect(m.review_gaps).toEqual({ by_verdict: null, gaps: null });
    expect(m.not_found.filter((n) => n.at === "review_gaps")).toEqual([
      { at: "review_gaps", reason: "1 event line could not be read, so the counts are not known" },
    ]);
  });

  it("is not measured when a session.yaml is missing or is not a session", async () => {
    const [s1, s2] = [SES("C01"), SES("C02")];
    await placeWork(
      s1,
      "claude-code-import",
      ran(s1, "E01", "2026-10-01T10:05:00Z", "git commit -m a", ALPHA),
    );
    await placeWork(
      s2,
      "claude-code-import",
      ran(s2, "E02", "2026-10-01T10:05:00Z", "git commit -m b", BETA),
    );
    await writeFile(join(paths.sessions, s1, "session.yaml"), "session: [not, a, session]\n");
    const m = await measure(declare([]));
    expect(m.review_gaps).toEqual({ by_verdict: null, gaps: null });
    expect(m.not_found).toEqual([
      { at: "review_gaps", reason: "1 session could not be read, so the counts are not known" },
    ]);
    expect(m.complete).toBe(false);
    await unlink(join(paths.sessions, s2, "session.yaml"));
    expect((await measure(declare([]))).not_found).toContainEqual({
      at: "review_gaps",
      reason: "2 sessions could not be read, so the counts are not known",
    });
  });

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )("is not measured when an events.jsonl cannot be read", async () => {
    const s1 = SES("C01");
    await placeWork(
      s1,
      "claude-code-import",
      ran(s1, "E01", "2026-10-01T10:05:00Z", "git commit -m a", ALPHA),
    );
    const events = join(paths.sessions, s1, "events.jsonl");
    await chmod(events, 0o000);
    try {
      const m = await measure(declare([]));
      expect(m.review_gaps).toEqual({ by_verdict: null, gaps: null });
      expect(m.not_found).toContainEqual({
        at: "review_gaps",
        reason: "1 session could not be read, so the counts are not known",
      });
    } finally {
      await chmod(events, 0o644);
    }
  });

  it("names its method's version, and is in the digest", async () => {
    const declaration = declare([]);
    const s1 = SES("C01");
    await placeWork(
      s1,
      "claude-code-import",
      ran(s1, "E01", "2026-10-01T10:05:00Z", "echo a", ALPHA),
    );
    const none = await measure(declaration);
    expect(none.methods).toEqual({ repos: 1, trail: 1, integrity: 1, review_gaps: 1 });
    await placeWork(
      s1,
      "claude-code-import",
      ran(s1, "E01", "2026-10-01T10:05:00Z", "git commit -m a", ALPHA),
    );
    const gap = await measure(declaration);
    expect(gap.review_gaps.gaps).toBe(1);
    // The trail and the integrity are the same in both; only the review gaps differ.
    expect(gap.trail).toEqual(none.trail);
    expect(gap.integrity).toEqual(none.integrity);
    expect(gap.digest).not.toBe(none.digest);
    expect((await measure(declaration, new Date("2026-12-01T00:00:00.000Z"))).digest).toBe(
      gap.digest,
    );
  });
});
