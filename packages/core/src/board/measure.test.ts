import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
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

function measure(declaration: BoardDeclaration, now: Date = NOW): Promise<BoardMeasurement> {
  return measureBoard({ declaration, root, paths, now, measuredWith: WITH });
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
    expect(m.complete).toBe(true);
  });

  it("does not count tasks when one of them cannot be read", async () => {
    await placeTask(TASK("T01"), "done");
    await writeFile(join(paths.tasks, `${TASK("T02")}.md`), "not a task\n");
    const skipped: string[] = [];
    const m = await measureBoard({
      declaration: declare(TRAIL),
      root,
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
      "measures",
      "ratios",
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
    expect(m.not_found[0]).toEqual({
      at: "measures.all",
      reason: "1 event line could not be read, so decisions may be missing",
    });
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
