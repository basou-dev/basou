import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { createManifest, ensureBasouDirectory, type RepoEntry, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunBoardMeasure, runBoardMeasure } from "./board.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const NOW = new Date("2026-10-05T03:00:00.000Z");
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-board-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  if (tmpRepo !== undefined) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

async function workspace(repos?: RepoEntry[]): Promise<string> {
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "board-ws",
    now: NOW,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, repos === undefined ? manifest : { ...manifest, repos });
  await writeFile(join(repo, "README.md"), "# ws\n");
  await writeFile(join(repo, "NOTES.md"), "a\nb\n");
  return repo;
}

const STAGES = Object.fromEntries(
  ["01", "02", "03", "04", "05", "06"].map((id) => [id, { meaning: `stage ${id}` }]),
);

// JSON is YAML 1.2, so the fixture needs no YAML writer.
function boardYaml(measures: Record<string, unknown>[]): string {
  return JSON.stringify(
    {
      board_version: 1,
      title: "Board",
      stages: STAGES,
      lanes: [{ id: "core", name: "Core" }],
      measures,
      axis: { version: 1, review_due_days: 60 },
      effort: { start: "2026-04-28" },
    },
    null,
    2,
  );
}

const MD = { id: "md", kind: "file_count", repo: ".", include: ["*.md"], unit: "files" };

async function placeBoard(repo: string, text: string, at = "board/board.yaml"): Promise<void> {
  await mkdir(join(repo, at, ".."), { recursive: true });
  await writeFile(join(repo, at), text);
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(" "));
  });
  return { out, err };
}

const ctx = (cwd: string) => ({ cwd, nowProvider: () => NOW });

describe("basou board measure", () => {
  it("reads board/board.yaml when the manifest declares the workspace's own repo private", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([MD]));
    const { out } = capture();
    await runBoardMeasure({ json: true }, ctx(repo));
    const result = JSON.parse(out.join("\n"));
    expect(result).toMatchObject({
      board_version: 1,
      title: "Board",
      measured_at: NOW.toISOString(),
      complete: true,
      not_found: [],
      measures: { md: { value: 2, unit: "files" } },
    });
    expect(result.measured_with.basou).toMatch(/^\d+\.\d+\.\d+/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each<[string, RepoEntry[] | undefined]>([
    ["no repos", undefined],
    ["a public repo", [{ path: ".", visibility: "public" }]],
    ["no visibility", [{ path: "." }]],
  ])("needs --board when the manifest declares %s", async (_what, repos) => {
    const repo = await workspace(repos);
    await placeBoard(repo, boardYaml([]));
    const { out, err } = capture();
    await runBoardMeasure({ json: true }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain(
      "No --board given, and the default board/board.yaml is used only when the manifest declares this workspace's own repo (path: .) private. Pass --board <path to board.yaml>.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reads --board relative to the working directory, and says when it is not there", async () => {
    const repo = await workspace([{ path: "." }]);
    await placeBoard(repo, boardYaml([MD]), "elsewhere/my-board.yaml");
    await mkdir(join(repo, "sub"));
    const { out, err } = capture();
    await runBoardMeasure(
      { json: true, board: "../elsewhere/my-board.yaml" },
      ctx(join(repo, "sub")),
    );
    expect(JSON.parse(out.join("\n")).measures.md.value).toBe(2);
    await runBoardMeasure({ json: true, board: "nope.yaml" }, ctx(repo));
    expect(err.join("\n")).toContain("No board declaration at nope.yaml.");
    expect(process.exitCode).toBe(1);
  });

  it("prints no repos when the manifest declares none", async () => {
    const repo = await workspace();
    await placeBoard(repo, boardYaml([]));
    const { out } = capture();
    const result = await doRunBoardMeasure({ board: "board/board.yaml" }, ctx(repo));
    expect(result.repos).toEqual([]);
    expect(out.join("\n")).not.toContain("Repos:");
  });

  it("prints nothing on stdout and every problem on stderr for a declaration it cannot read", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(
      repo,
      boardYaml([
        { ...MD, repo: "../elsewhere" },
        { id: "x", kind: "file_count", repo: ".", unit: "files" },
      ]),
    );
    const { out, err } = capture();
    await runBoardMeasure({ json: true }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toBe(
      [
        "board/board.yaml is not a valid board declaration:",
        "  - measures[1].include: Invalid input: expected array, received undefined",
        "  - measures[0].repo: '../elsewhere' is not a repo path in the manifest (the manifest declares '.')",
      ].join("\n"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("prints what it measured and exits 1 when something could not be measured", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(
      repo,
      boardYaml([
        MD,
        { id: "gone", kind: "line_count", repo: ".", include: ["GONE.md"], unit: "lines" },
      ]),
    );
    const { out } = capture();
    const result = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(result.complete).toBe(false);
    expect(JSON.parse(out.join("\n")).not_found).toEqual([
      { at: "measures.gone", reason: "'GONE.md' matches no file in the working tree" },
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("prints a summary without --json", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(
      repo,
      boardYaml([
        { ...MD, lane: "core" },
        { id: "gone", kind: "line_count", repo: ".", include: ["GONE.md"], unit: "lines" },
      ]),
    );
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain("md    2 files  [core]");
    expect(text).toContain(`\nRepos:\n  . (${basename(repo)})  `);
    expect(text).toContain("gone  not measured");
    expect(text).toContain(
      "Not measured (1):\n  measures.gone: 'GONE.md' matches no file in the working tree",
    );
    expect(text).toContain("Complete: no");
    expect(text).toMatch(/Digest: sha256:[0-9a-f]{64}/);
  });

  it("prints each repo in the summary, saying what a null means", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }, { path: "../gone" }]);
    await placeBoard(repo, boardYaml([]));
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    const name = basename(repo);
    const unborn = out.join("\n");
    expect(unborn).toMatch(
      new RegExp(
        `Repos:\\n  \\. \\(${name}\\)  main at no commit yet, last commit none, commits 0, files \\d+, uncommitted \\d+, behind origin/main \\(no origin/main\\)\\n  \\.\\./gone  not measured\\n`,
      ),
    );
    expect(unborn).toContain("repos[../gone]: the repo '../gone' is not on disk");

    await execFileAsync("git", ["add", "README.md"], { cwd: repo, env: ENV });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "one"],
      {
        cwd: repo,
        env: { ...ENV, GIT_COMMITTER_DATE: "2026-10-04T23:30:00+09:00" },
      },
    );
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, env: ENV });
    await execFileAsync("git", ["checkout", "-q", "--detach"], { cwd: repo, env: ENV });
    out.length = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain(
      `  . (${name})  detached HEAD at ${stdout.slice(0, 7)}, last commit 2026-10-04T23:30:00+09:00, commits 1, files `,
    );
  });

  it("refuses a workspace that is not initialized", async () => {
    const repo = await realpath(tmpRepo as string);
    const { out, err } = capture();
    await runBoardMeasure({ board: "board.yaml" }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Workspace not initialized. Run 'basou init' first.");
    expect(process.exitCode).toBe(1);
  });
});

describe("basou board measure: what the review found", () => {
  const ESC = String.fromCharCode(27);

  it("looks for the workspace's own repo by its path, not at the first entry", async () => {
    const repo = await workspace([
      { path: "../other", visibility: "private" },
      { path: ".", visibility: "public" },
    ]);
    await placeBoard(repo, boardYaml([]));
    const { out, err } = capture();
    await runBoardMeasure({ json: true }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("No --board given");
  });

  it.skipIf(process.platform === "win32")(
    "escapes a control character in a reason and in the board path",
    async () => {
      const repo = await workspace([{ path: ".", visibility: "private" }]);
      await symlink("/", join(repo, `e${ESC}.md`));
      await placeBoard(repo, boardYaml([MD]));
      const { out, err } = capture();
      await runBoardMeasure({}, ctx(repo));
      expect(out.join("\n")).toContain("measures.md: 'e");
      expect(out.join("\n")).toContain("is a symlink to outside the repository");
      expect(out.join("\n")).not.toContain(ESC);
      await runBoardMeasure({ board: `missing${ESC}.yaml` }, ctx(repo));
      expect(err.join("\n")).toContain("No board declaration at missing");
      expect(err.join("\n")).not.toContain(ESC);
    },
  );

  it("says when --board names a directory", async () => {
    const repo = await workspace([{ path: "." }]);
    await mkdir(join(repo, "boards"));
    const { err } = capture();
    await runBoardMeasure({ board: "boards" }, ctx(repo));
    expect(err.join("\n")).toContain("boards is a directory, not a board declaration.");
    expect(process.exitCode).toBe(1);
  });

  it("rounds a ratio in the summary", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await writeFile(join(repo, "ONE.md"), "1\n");
    await writeFile(join(repo, "THREE.md"), "1\n2\n3\n");
    const text = JSON.parse(
      boardYaml([
        { id: "one", kind: "line_count", repo: ".", include: ["ONE.md"], unit: "lines" },
        { id: "three", kind: "line_count", repo: ".", include: ["THREE.md"], unit: "lines" },
      ]),
    );
    text.ratios = [{ id: "third", label: "r", numerator: "one", denominator: "three" }];
    await placeBoard(repo, JSON.stringify(text, null, 2));
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain("third  0.3333  (one / three)");
  });
});
