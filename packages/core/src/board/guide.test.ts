import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { type BoardDeclaration, parseBoardDeclaration } from "./declaration.js";
import {
  BOARD_GUIDE_PORTS,
  type BoardGuideInput,
  boardGuide,
  boardGuidePort,
  boardGuideWorkDir,
  shellWord,
} from "./guide.js";
import {
  type BoardPreviousRecords,
  NO_PREVIOUS_RECORDS,
  type ReadBoardRecord,
} from "./previous.js";
import { parseRecordInput } from "./record.js";

const STAGES = ["01", "02", "03", "04", "05", "06"];
const ANCHOR = "/work/a b's board";
const NOW = new Date("2026-10-09T03:00:00.000Z");
// The shell word the working directory starts with.
const TMPDIR_WORD = ["$", "{TMPDIR:-/tmp}"].join("");

function declaration(over: Record<string, unknown> = {}): BoardDeclaration {
  const result = parseBoardDeclaration(
    stringify({
      board_version: 2,
      title: "Test board",
      stages: Object.fromEntries(
        STAGES.map((id) => [
          id,
          id === "05"
            ? { meaning: "open", look: ["the npm version"], notes: ["merged is not open"] }
            : { meaning: `stage ${id}` },
        ]),
      ),
      lanes: [
        { id: "core", name: "Core", about: "the engine", notes: ["06 needs a real run"] },
        { id: "docs", name: "Docs" },
      ],
      observe: [
        { key: "npm_cli", kind: "npm_version", package: "@scope/cli" },
        { key: "release", kind: "github_release", repo: "owner/name" },
        { key: "issues", kind: "github_open_issues", repo: "owner/name" },
        { key: "prs", kind: "github_open_prs", repo: "owner/name" },
        { key: "ci", kind: "github_ci", repo: "owner/name", workflow: "quality.yml" },
        { key: "site", kind: "page_version", url: "https://example.com/ja/?a=1&b=2" },
        { key: "users", kind: "manual", how: "count the users in production, read only" },
      ],
      axis: { version: 3, review_due_days: 60 },
      effort: { start: "2026-04-28", time_zone: "UTC" },
      ...over,
    }),
    { manifestRepoPaths: [".", "../app"] },
  );
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.declaration;
}

function guideInput(over: Partial<BoardGuideInput> = {}): BoardGuideInput {
  return {
    anchor: ANCHOR,
    otherRepos: ["../app"],
    language: "ja",
    basouCommand: "'/usr/bin/node' '/opt/basou/index.js'",
    basouVersion: "0.0.0-test",
    now: NOW,
    board: {
      status: "declared",
      declaration: declaration(),
      recordCount: 0,
      previous: NO_PREVIOUS_RECORDS,
    },
    ...over,
  };
}

// A record as read back, with the cells given.
function readRecord(
  cells: { lane: string; stage: string; state: string; reason?: string }[],
  over: Record<string, unknown> = {},
): ReadBoardRecord {
  return {
    record_version: 2,
    recorded_at: "2026-10-07T00:00:00.000Z",
    measure: { methods: {}, components: { found: null } },
    observed: {},
    cells,
    judged_by: { model: "Claude Opus 5.5" },
    axis_review: null,
    ...over,
  } as ReadBoardRecord;
}

// The record's input the guide prints, as JSON.
function templateIn(guide: string): Record<string, unknown> {
  const start = guide.indexOf("```json\n");
  const end = guide.indexOf("\n```", start + 1);
  if (start === -1 || end === -1) throw new Error("no template");
  return JSON.parse(guide.slice(start + "```json\n".length, end));
}

// The blocks of shell commands the guide prints.
function blocksIn(guide: string): string[] {
  return [...guide.matchAll(/```sh\n([\s\S]*?)\n```/g)].map((m) => m[1] as string);
}

describe("boardGuidePort and boardGuideWorkDir", () => {
  it("chooses the same port for the same path, in its range, and not basou view's default", () => {
    const port = boardGuidePort(ANCHOR);
    expect(boardGuidePort(ANCHOR)).toBe(port);
    const ports = Array.from({ length: 200 }, (_, i) => boardGuidePort(`/work/ws-${i}`));
    for (const p of [port, ...ports]) {
      expect(p).toBeGreaterThanOrEqual(BOARD_GUIDE_PORTS.first);
      expect(p).toBeLessThan(BOARD_GUIDE_PORTS.first + BOARD_GUIDE_PORTS.count);
      expect(p).not.toBe(4319);
    }
    // Spread over the range, not piled on a few ports.
    expect(new Set(ports).size).toBeGreaterThan(150);
  });

  it("names a working directory by the path's hash, not by its name", () => {
    expect(boardGuideWorkDir(ANCHOR)).toMatch(/^\$\{TMPDIR:-\/tmp\}\/basou-board-[0-9a-f]{12}$/);
    expect(boardGuideWorkDir(ANCHOR)).not.toBe(boardGuideWorkDir("/work/other"));
  });
});

describe("shellWord", () => {
  it.each([["plain"], ["it's"], ["$(rm -rf ~) `x` $HOME"], ["a\nb"], ["'"], [""]])(
    "is read back by sh as %j",
    (text) => {
      expect(execFileSync("sh", ["-c", `printf %s ${shellWord(text)}`], { encoding: "utf8" })).toBe(
        text,
      );
    },
  );
});

describe("boardGuide: a board declared", () => {
  it("says where the board is, its last record, its axis, the prose language and the port", () => {
    const guide = boardGuide(
      guideInput({
        board: {
          status: "declared",
          declaration: declaration(),
          recordCount: 2,
          previous: {
            last: {
              status: "found",
              id: "01M4E6PAN7J2BJ5YK1NFPVAQAR",
              record: readRecord([]),
            },
            lastReview: {
              status: "found",
              id: "01M4A00000000000000000000A",
              record: readRecord([], {
                recorded_at: "2026-09-30T23:30:00.000Z",
                judged_by: { model: "Old Model" },
              }),
            },
          },
        },
      }),
    );
    expect(guide).toContain(`- Workspace (its own repo): ${ANCHOR}`);
    expect(guide).toContain(
      '- Declaration: board/board.yaml, "Test board", board_version 2, 2 lanes, 7 observations outside basou',
    );
    expect(guide).toContain(
      "- Records: board/records/, 2 records; the last is 01M4E6PAN7J2BJ5YK1NFPVAQAR, recorded 2026-10-08T16:49:07.751Z, 1 day ago",
    );
    expect(guide).toContain(
      "- Axis: version 3, due a review every 60 days; last reviewed 2026-09-30 by Old Model (record 01M4A00000000000000000000A)",
    );
    expect(guide).toContain("write every prose string and reason in Japanese (ja)");
    expect(guide).toContain(`- Board page port: ${boardGuidePort(ANCHOR)}`);
    expect(guide).toContain(`- Working files: ${boardGuideWorkDir(ANCHOR)}`);
    expect(guide).toContain("'/usr/bin/node' '/opt/basou/index.js'");
    expect(guide).toContain("basou 0.0.0-test");
  });

  it("says when there is no record yet, and when the last cannot be read", () => {
    expect(boardGuide(guideInput())).toContain(
      "- Records: board/records/, none yet; this will be the first",
    );
    expect(boardGuide(guideInput())).toContain(
      "- Axis: version 3, due a review every 60 days; no review on record (the first record is the first review",
    );
    const unreadable: BoardPreviousRecords = {
      last: { status: "unreadable", reason: "the record X could not be read as JSON" },
      lastReview: { status: "unreadable", reason: "the record X could not be read as JSON" },
    };
    const guide = boardGuide(
      guideInput({
        board: {
          status: "declared",
          declaration: declaration(),
          recordCount: 1,
          previous: unreadable,
        },
      }),
    );
    expect(guide).toContain(
      "- Records: board/records/, 1 record; the last cannot be read (the record X could not be read as JSON)",
    );
    expect(guide).toContain("the last review is not known (a record cannot be read)");
    expect(guide).toContain(
      "The previous record cannot be read (the record X could not be read as JSON)",
    );
  });

  it("takes the seed review when no record has one, and says when records hold none", () => {
    const seeded = declaration({
      axis: { version: 1, review_due_days: 30, seed_review: { date: "2026-09-28", model: "M" } },
    });
    expect(
      boardGuide(
        guideInput({
          board: {
            status: "declared",
            declaration: seeded,
            recordCount: 0,
            previous: NO_PREVIOUS_RECORDS,
          },
        }),
      ),
    ).toContain("last reviewed 2026-09-28 by M (seed_review in board.yaml)");
    const found: BoardPreviousRecords = {
      last: { status: "found", id: "01M4A00000000000000000000A", record: readRecord([]) },
      lastReview: { status: "none" },
    };
    expect(
      boardGuide(
        guideInput({
          board: {
            status: "declared",
            declaration: declaration(),
            recordCount: 1,
            previous: found,
          },
        }),
      ),
    ).toContain("no review on record (measure's axis section says whether one is due)");
  });

  it("gives each observation's command, its value and its source, quoted for the shell", () => {
    const guide = boardGuide(guideInput());
    const blocks = blocksIn(guide).join("\n");
    expect(blocks).toContain(`npm view '@scope/cli' version; echo "exit=$?"`);
    expect(blocks).toContain("gh release view --repo 'owner/name' --json tagName -q .tagName");
    expect(blocks).toContain(
      "gh issue list --repo 'owner/name' --state open --limit 1000 --json number -q length",
    );
    expect(blocks).toContain(
      "gh pr list --repo 'owner/name' --state open --limit 1000 --json number -q length",
    );
    expect(blocks).toContain(
      "gh run list --repo 'owner/name' --workflow 'quality.yml' --branch 'main' --limit 1",
    );
    expect(blocks).toContain(
      `curl -fsS --max-time 20 'https://example.com/ja/?a=1&b=2' > "$W/page-site.html"`,
    );
    expect(guide).toContain(
      "Only the operator can make this one: count the users in production, read only",
    );
    expect(guide).toContain("- Observing `users`: count the users in production, read only");
    expect(guide).toContain(
      "Source: `gh run list --repo owner/name --workflow quality.yml --branch main`.",
    );
  });

  it("leaves the model to be named, in the commands and the template, so neither runs as printed", () => {
    const guide = boardGuide(guideInput());
    const blocks = blocksIn(guide).join("\n");
    expect(blocks).not.toContain("<model>");
    expect(blocks).not.toContain("<the port");
    expect(blocks).toContain('basou board measure --json --model "$MODEL"');
    expect(blocks).toContain(`curl -s http://127.0.0.1:${boardGuidePort(ANCHOR)}/api/board`);
    const template = templateIn(guide);
    expect(template.judged_by).toEqual({ model: "", self_reported: true });
    expect(template.prose).toEqual({ summary: "", lanes: {}, operator_turns: [], footnotes: [] });
    expect(Object.values(template.observed as Record<string, object>).map(Object.keys)).toEqual(
      Array.from({ length: 7 }, () => ["value", "observed_at", "source"]),
    );
    expect(guide).toContain("the lane ids are `core`, `docs`.");
    expect(guide).toContain(
      "write every prose string and reason in Japanese (ja), the language this board's page is drawn in",
    );
  });

  it("says to declare what to observe when nothing is declared", () => {
    const guide = boardGuide(
      guideInput({
        board: {
          status: "declared",
          declaration: declaration({ observe: [] }),
          recordCount: 0,
          previous: NO_PREVIOUS_RECORDS,
        },
      }),
    );
    expect(guide).toContain("This board declares nothing to observe outside basou.");
    expect(templateIn(guide).observed).toEqual({});
  });

  it("lists each stage with what to look at and mind, and each lane with its notes", () => {
    const guide = boardGuide(guideInput());
    expect(guide).toContain(
      "- 05: open\n  - look at: the npm version\n  - mind: merged is not open\n- 06: stage 06",
    );
    expect(guide).toContain(
      "- `core` Core: the engine\n  - mind: 06 needs a real run\n- `docs` Docs\n",
    );
  });

  it("escapes what a terminal would act on in the board's own words", () => {
    const d = declaration({
      title: "T\u001b[31m",
      lanes: [{ id: "core", name: "Co\u0085re", notes: [`a${String.fromCodePoint(0x202e)}b`] }],
    });
    const guide = boardGuide(
      guideInput({
        board: {
          status: "declared",
          declaration: d,
          recordCount: 0,
          previous: NO_PREVIOUS_RECORDS,
        },
      }),
    );
    expect(guide).toContain('"T\\x1b[31m"');
    expect(guide).toContain("- `core` Co\\x85re\n  - mind: a\\u202eb");
    const acting = [0x1b, 0x85, 0x202e];
    expect([...guide].some((c) => acting.includes(c.codePointAt(0) ?? 0))).toBe(false);
  });
});

describe("boardGuide: the record's input", () => {
  const previous: BoardPreviousRecords = {
    last: {
      status: "found",
      id: "01M4A00000000000000000000A",
      record: readRecord([
        { lane: "core", stage: "01", state: "done" },
        { lane: "core", stage: "06", state: "unverified", reason: "needs a run elsewhere" },
        { lane: "gone", stage: "01", state: "done" },
      ]),
    },
    lastReview: { status: "none" },
  };

  it("leaves every state empty, with the previous record's state and reason beside it", () => {
    const template = templateIn(
      boardGuide(
        guideInput({
          board: { status: "declared", declaration: declaration(), recordCount: 1, previous },
        }),
      ),
    );
    const cells = template.cells as Record<string, unknown>[];
    expect(cells).toHaveLength(12);
    expect(cells[0]).toEqual({ lane: "core", stage: "01", state: "", previous: { state: "done" } });
    expect(cells[1]).toEqual({ lane: "core", stage: "02", state: "", previous: null });
    expect(cells[5]).toEqual({
      lane: "core",
      stage: "06",
      state: "",
      previous: { state: "unverified", reason: "needs a run elsewhere" },
    });
    expect(cells.every((c) => c.state === "")).toBe(true);
  });

  it("has no previous beside the cells when there is no previous record", () => {
    const cells = templateIn(boardGuide(guideInput())).cells as Record<string, unknown>[];
    expect(cells.map((c) => Object.keys(c))).toEqual(
      Array.from({ length: 12 }, () => ["lane", "stage", "state"]),
    );
  });

  it("is refused by record as printed, and taken once each cell is judged and each observation made", () => {
    const d = declaration();
    const template = templateIn(
      boardGuide(
        guideInput({ board: { status: "declared", declaration: d, recordCount: 1, previous } }),
      ),
    );
    const refused = parseRecordInput(template, d);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors).toContain(
        "cells[0].state: must be one of done, part, blocked, shelved, none, unverified",
      );
      expect(refused.errors).toContain("cells[0]: unknown key 'previous'");
      expect(refused.errors.some((e) => e.startsWith("observed.npm_cli.observed_at:"))).toBe(true);
      expect(refused.errors.some((e) => e.startsWith("measure_digest:"))).toBe(true);
    }
    const observed = template.observed as Record<string, Record<string, unknown>>;
    expect(Object.keys(observed)).toEqual(d.observe.map((o) => o.key));
    expect(observed.site?.source).toBe("https://example.com/ja/?a=1&b=2");
    expect(observed.users?.source).toBe("the operator");
    for (const o of Object.values(observed)) {
      o.observed_at = "2026-10-09T03:00:00Z";
      o.error = "not observed in this test";
    }
    template.measure_digest = `sha256:${"a".repeat(64)}`;
    template.cells = (template.cells as Record<string, unknown>[]).map(
      ({ previous: _p, ...cell }) => ({ ...cell, state: "none" }),
    );
    (template.judged_by as Record<string, unknown>).model = "Claude Opus 5.5";
    const taken = parseRecordInput(template, d);
    expect(taken.ok ? [] : taken.errors).toEqual([]);
  });
});

describe("boardGuide: no board declared", () => {
  it("says how to declare one instead of the steps", () => {
    const guide = boardGuide(guideInput({ board: { status: "undeclared" } }));
    expect(guide).toContain("## No board is declared yet");
    expect(guide).toContain("Write board/board.yaml (board_version 2)");
    expect(guide).toContain("Run `basou board guide` again");
    expect(guide).not.toContain("## Steps");
    expect(guide).not.toContain("```json");
  });
});

describe("boardGuide: the commands run", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-board-guide-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
      cwd,
      encoding: "utf8",
    });

  it("takes the before of the other repos, and gate (d) tells a change apart", async () => {
    const anchor = join(dir, "it's here");
    const other = join(dir, "other repo");
    for (const repo of [anchor, other]) {
      await mkdir(repo);
      git(repo, "init", "-q", "-b", "main");
      await writeFile(join(repo, "a.txt"), "a\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "init");
    }
    const guide = boardGuide(guideInput({ anchor, otherRepos: ["../other repo"], language: "en" }));
    const blocks = blocksIn(guide);
    const before = blocks.find((b) => b.includes('> "$W/before.txt"')) as string;
    const gate = blocks.find((b) => b.includes('echo "(d) same"')) as string;
    const env = { ...process.env, TMPDIR: dir };
    const sh = (script: string) => {
      try {
        return { out: execFileSync("sh", ["-c", script], { env, encoding: "utf8" }), code: 0 };
      } catch (error: unknown) {
        return { out: String((error as { stdout?: unknown }).stdout ?? ""), code: 1 };
      }
    };
    expect(sh(before).out).toContain("exit=0");
    const work = boardGuideWorkDir(anchor).replace(TMPDIR_WORD, dir);
    expect(await readFile(join(work, "before.txt"), "utf8")).toMatch(
      /^\.\.\/other repo [0-9a-f]{40} [0-9a-f]{40}\n$/,
    );
    expect(sh(gate)).toEqual({ out: "(d) same\n", code: 0 });
    await writeFile(join(other, "b.txt"), "b\n");
    expect(sh(gate).code).toBe(1);
    // Edits to a file already changed, and to one not tracked, are changes too.
    await writeFile(join(other, "a.txt"), "a changed\n");
    expect(sh(before).out).toContain("exit=0");
    expect(sh(gate).code).toBe(0);
    await writeFile(join(other, "a.txt"), "a changed again\n");
    expect(sh(gate).code).toBe(1);
    expect(sh(before).out).toContain("exit=0");
    await writeFile(join(other, "b.txt"), "b changed\n");
    expect(sh(gate).code).toBe(1);
    // A repo that cannot be read stops the before instead of leaving it out.
    const missing = boardGuide(guideInput({ anchor, otherRepos: ["../nowhere"], language: "en" }));
    const stop = blocksIn(missing).find((b) => b.includes('> "$W/before.txt"')) as string;
    expect(sh(stop).out).toContain("exit=1");
  });

  it("uses a working directory only when it is the user's own and no link, and closes it to others", async () => {
    const guide = boardGuide(guideInput({ anchor: dir, otherRepos: [] }));
    const measure = blocksIn(guide).find((b) => b.includes('> "$W/measure.json"')) as string;
    const prefix = measure.slice(0, measure.indexOf(" && basou "));
    const work = boardGuideWorkDir(dir).replace(TMPDIR_WORD, dir);
    const env = { ...process.env, TMPDIR: dir };
    const sh = (script: string) => {
      try {
        execFileSync("sh", ["-c", script], { env, encoding: "utf8" });
        return 0;
      } catch {
        return 1;
      }
    };
    expect(sh(prefix)).toBe(0);
    expect((await stat(work)).mode & 0o777).toBe(0o700);
    await chmod(work, 0o755);
    expect(sh(prefix)).toBe(0);
    expect((await stat(work)).mode & 0o777).toBe(0o700);
    await rm(work, { recursive: true });
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, work);
    expect(sh(prefix)).toBe(1);
  });

  it("takes the before of a repo with no commit yet, and still tells a change apart", async () => {
    const anchor = join(dir, "ws");
    const fresh = join(dir, "fresh");
    await mkdir(anchor);
    await mkdir(fresh);
    git(fresh, "init", "-q", "-b", "main");
    await writeFile(join(fresh, "a.txt"), "a\n");
    const guide = boardGuide(guideInput({ anchor, otherRepos: ["../fresh"], language: "en" }));
    const blocks = blocksIn(guide);
    const before = blocks.find((b) => b.includes('> "$W/before.txt"')) as string;
    const gate = blocks.find((b) => b.includes('echo "(d) same"')) as string;
    const env = { ...process.env, TMPDIR: dir };
    const sh = (script: string) => {
      try {
        return execFileSync("sh", ["-c", script], { env, encoding: "utf8" });
      } catch {
        return "failed";
      }
    };
    expect(sh(before)).toContain("exit=0");
    const work = boardGuideWorkDir(anchor).replace(TMPDIR_WORD, dir);
    expect(await readFile(join(work, "before.txt"), "utf8")).toMatch(
      /^\.\.\/fresh no-commit [0-9a-f]{40}\n$/,
    );
    expect(sh(gate)).toBe("(d) same\n");
    await writeFile(join(fresh, "a.txt"), "b\n");
    expect(sh(gate)).toBe("failed");
  });

  it("says why it does not use a working directory that is a link", async () => {
    const guide = boardGuide(guideInput({ anchor: dir, otherRepos: [] }));
    const measure = blocksIn(guide).find((b) => b.includes('> "$W/measure.json"')) as string;
    const prefix = measure.slice(0, measure.indexOf(" && basou "));
    const work = boardGuideWorkDir(dir).replace(TMPDIR_WORD, dir);
    await mkdir(join(dir, "elsewhere"));
    await symlink(join(dir, "elsewhere"), work);
    const run = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn("sh", ["-c", prefix], { env: { ...process.env, TMPDIR: dir } });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toBe(`not a directory of your own, so not used: ${work}\n`);
  });

  it("passes gate (e) with exit 0 when only board/ is staged, and fails it otherwise", async () => {
    const anchor = join(dir, "ws");
    await mkdir(join(anchor, "board"), { recursive: true });
    git(anchor, "init", "-q", "-b", "main");
    await writeFile(join(anchor, "board", "board.yaml"), "x\n");
    const guide = boardGuide(guideInput({ anchor, otherRepos: [] }));
    const gate = blocksIn(guide).find((b) => b.includes("git add -- board")) as string;
    const sh = () => {
      try {
        return { out: execFileSync("sh", ["-c", gate], { encoding: "utf8" }), code: 0 };
      } catch (error: unknown) {
        return { out: String((error as { stdout?: unknown }).stdout ?? ""), code: 1 };
      }
    };
    expect(sh()).toEqual({ out: "(e) only board/\n", code: 0 });
    await writeFile(join(anchor, "other.txt"), "x\n");
    git(anchor, "add", "other.txt");
    expect(sh()).toEqual({ out: "other.txt\n(e) more than board/ is staged\n", code: 1 });
  });

  it("reads the version off a page, past the generator meta tag and a bare number", async () => {
    const guide = boardGuide(guideInput({ anchor: dir }));
    const read = (blocksIn(guide).find((b) => b.includes('> "$W/page-site.html"')) ?? "")
      .split("\n")
      .find((l) => l.includes("node -e")) as string;
    const work = boardGuideWorkDir(dir).replace(TMPDIR_WORD, dir);
    await mkdir(work, { recursive: true });
    const run = async (html: string) => {
      await writeFile(join(work, "page-site.html"), html);
      return execFileSync("sh", ["-c", read], {
        env: { ...process.env, TMPDIR: dir },
        encoding: "utf8",
      });
    };
    expect(
      await run(
        '<meta name="generator" content="Starlight v0.39.2"><p>Node.js 20.10.0, tool-dev2.0.0, 1.v3.0.0, latest v1.2.3-rc.1</p><p>v9.9.9</p>',
      ),
    ).toBe("v1.2.3-rc.1\nexit=0\n");
    expect(await run("<p>no version, 1.2.3 alone</p>")).toBe("exit=1\n");
    for (const meta of [
      '<meta name=generator content="Astro v4.16.18">',
      "<meta name='generator' content='Docusaurus v3.5.2'>",
      '<META NAME="Generator" CONTENT="Jekyll v4.3.2">',
      '<meta content="Hugo v0.120.0" name="generator" />',
    ]) {
      expect(await run(`${meta}<p>release_v9.9.9 then v1.2.3</p>`)).toBe("v1.2.3\nexit=0\n");
    }
  });
});
