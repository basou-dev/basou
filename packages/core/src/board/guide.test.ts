import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { type BoardDeclaration, type BoardObserve, parseBoardDeclaration } from "./declaration.js";
import {
  BOARD_GUIDE_PORTS,
  type BoardGuideInput,
  boardGuide,
  boardGuidePort,
  boardGuideWorkDir,
  shellWord,
} from "./guide.js";
import { BOARD_INIT_SAVE } from "./init.js";
import { observedValueProblems } from "./observed-shape.js";
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
    basouBuild: "abc1234",
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
      // The record's own time, not its name's: a record written before
      // 0.70.1 has a name of another time.
      "- Records: board/records/, 2 records; the last is 01M4E6PAN7J2BJ5YK1NFPVAQAR, recorded 2026-10-07T00:00:00.000Z, 2 days ago",
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
      '- Axis: version 3, due a review every 60 days; no review on record (the first record is the first review: give it an axis_review, step 2b; its triggers are the letters axis.reasons gives, and "a" too when the components were registered for it: registering clears (a), but (a) led to the review)',
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
    expect(guide).toContain(
      "- Making the manual observations, asked for together in one message:\n  - `users`: count the users in production, read only\n",
    );
    // A plain name is given as it is, as before.
    expect(guide).toContain(
      "Source: `gh run list --repo owner/name --workflow quality.yml --branch main`.",
    );
  });

  it("says how to ask for a manual observation, and what the source says when the operator hands it over", () => {
    const guide = boardGuide(guideInput());
    expect(guide).toContain(
      "Ask once, in one message, for all the manual observations of this record: for each key, what they can do as it is written (the line to run and where to run it, or the page to open) and what to send back; when one line answers several keys, give it once and say which keys it answers.",
    );
    expect(guide).not.toContain("Ask for one thing");
    expect(guide).toContain(
      "When the operator tells you to make it yourself, make it as they said and write that in the source instead, such as `ran <the command> as the operator asked`.",
    );
  });

  it("asks for every manual observation in one message, and lists them as one turn of the operator's", () => {
    const withManual = (observe: Record<string, unknown>[]) =>
      boardGuide(guideInput({ board: declared(httpDeclaration(observe)) }));
    const two = withManual([
      { key: "users", kind: "manual", how: "count the users in production" },
      { key: "site", kind: "http", url: "https://example.com/" },
      { key: "orders", kind: "manual", how: "count the orders today" },
    ]);
    const turns = two.slice(two.indexOf("## The operator's turns in this work"));
    expect(turns).toContain(
      [
        "- Approving a milestone before it is added to board.yaml.",
        "- Making the manual observations, asked for together in one message:",
        "  - `users`: count the users in production",
        "  - `orders`: count the orders today",
        "- A gate of step 9 that does not pass.",
      ].join("\n"),
    );
    expect(two.split("- Making the manual observations")).toHaveLength(2);
    expect(two).not.toContain("- Observing `");
    expect(two).toContain("Ask once, in one message, for all the manual observations");
    const none = withManual([{ key: "site", kind: "http", url: "https://example.com/" }]);
    expect(none).not.toContain("manual observations");
    expect(none).toContain(
      "- Approving a milestone before it is added to board.yaml.\n- A gate of step 9 that does not pass.",
    );
  });

  it("asks for decision and task ids in full, in the prose and in a milestone's ref", () => {
    const guide = boardGuide(guideInput());
    expect(guide).toContain(
      "Write a decision or task id in full, all 26 characters after `decision_` or `task_`: basou prints some of them short, and a short one can match more than one, a voided decision among them.",
    );
    expect(guide).toContain(
      "with `ref` saying where it can be checked (a tag and its commit, or a decision id in full).",
    );
  });

  it("names 04 merged, not production: where a merge deploys at once, production is 05", () => {
    const guide = boardGuide(guideInput());
    expect(guide).toContain(
      "04 (merged) and 05 (open, in users' hands) are apart on purpose: what is merged but not published is used by no one.",
    );
    expect(guide).not.toContain("merged, in production");
    const undeclared = boardGuide(guideInput({ board: { status: "undeclared" } }));
    expect(undeclared).toContain("keeping 04 (merged) apart from 05 (in users' hands)");
  });

  it("says where to read the paths of a file_paths measure, and how the diff gives them", () => {
    expect(boardGuide(guideInput())).toContain(
      "- A `file_paths` measure's value is the list of paths it found. `Measures:` in measure.txt gives it as a count: read the paths in the JSON. `diff` lists each path that came in (`added`) or went out (`removed`) when both records hold a list, and the list whole when only one does.",
    );
  });

  it("says the text of measure lists where board.yaml changed, which the JSON does not hold", () => {
    expect(boardGuide(guideInput())).toContain(
      "The top of measure.txt also lists each place where board.yaml changed since that record (`declaration <where>: added`, `removed` or `changed`, and `declaration lanes: the order changed`), or says `declaration: not compared` when that record holds no declaration basou can compare with, which the JSON does not hold: write an `axis_review`'s summary from these lines, not from memory.",
    );
  });

  it("says what a total's value is, that it may be below 0, and when it is null", () => {
    expect(boardGuide(guideInput())).toContain(
      "- A `total` measure's value is what its `plus` adds up to less what its `minus` adds up to, and may be below 0. It is null when a measure it takes was not measured, and when it is out of the range a number holds exactly (-9007199254740991 to 9007199254740991).",
    );
  });

  it("says which branch a repo is compared with, and that a null or old fetched_at makes the counts old", () => {
    expect(boardGuide(guideInput())).toContain(
      "- `repos[].base` is the branch of origin a repo is compared with (`origin/<branch>`: the one origin/HEAD names, or origin/main when origin/HEAD names none), `behind` counts the commits on it HEAD does not have, and `ahead` those HEAD has that it does not, as of the last fetch; measure does not fetch. `fetched_at` is when FETCH_HEAD was last written, given that it holds that branch fetched from origin at the commit it is at now (a later `git fetch --append` moves it too), and null when it does not (no fetch since the clone, a failed fetch, a fetch of something else since, or a push since). When it is null or old, `behind` and `ahead` may be old too.",
    );
  });

  it("says that ahead above 0 is not only commits not pushed, when judging 04", () => {
    expect(boardGuide(guideInput())).toContain(
      "2. What is not committed is not 04. Work left in a working tree stops at 03: written is not merged. A repo's `ahead` above 0 is commits not in its `base`, which are not only commits not pushed: a branch pushed and not merged has them, and so has one merged as other commits (a squash or a rebase). Read it with `branch` before judging 04; when `fetched_at` is null or old, it may be old too.",
    );
  });

  it("says a gone directory no built-in marker finds may take a marker, and not only to silence (a)", () => {
    const guide = boardGuide(guideInput());
    expect(guide).toContain(
      "If it is still there and no built-in marker finds it (a directory of content or of scripts), give it a `marker` (board_version 3 on): a glob from its directory, written as an `include` is, of the files that mark it (`**` for any file under it, `*.py` for a Python file right in it). It is then found, with the kind `marker`, while such a file is there; a repo itself takes none.",
    );
    expect(guide).toContain(
      "- Change the axis silently, or register a component, or give one a marker, only to silence (a).",
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
    expect(guide).toContain(
      "declare it under `observe` (board_version 2 on, and 3 for `http`, `github_check`, an observation's `notes` and a key with `.`)",
    );
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

describe("boardGuide: which basou to call, and what the digest covers", () => {
  it("calls basou as it is where it is this version and build, and the command otherwise", () => {
    const guide = boardGuide(guideInput());
    expect(guide).toContain(
      "basou: `'/usr/bin/node' '/opt/basou/index.js'` printed this. Where `basou --version` prints version 0.0.0-test, build abc1234, as this one is, call `basou` as the commands below do (an alias of your shell is as good). Otherwise (another version or build, or no `basou`), write that command in place of `basou` in every block. Use the same one at every step: a measurement records which basou measured it.",
    );
    expect(guide).not.toContain("not on PATH");
  });

  it("names no build for a basou without a build stamp", () => {
    expect(boardGuide(guideInput({ basouBuild: null }))).toContain(
      "Where `basou --version` prints version 0.0.0-test (source), as this one is,",
    );
  });

  it("says the digest covers board.yaml, and holds the counts of uncommitted paths", () => {
    const guide = boardGuide(guideInput());
    expect(guide).toContain(
      "the repos' commits and their counts of files and of uncommitted paths, the basou that measured, the portfolio's counts",
    );
    expect(guide).toContain(
      "The digest covers board.yaml as read too, so any change to what it declares moves it.",
    );
    expect(guide).toContain("A digest that differs means something measured or board.yaml changed");
  });
});

describe("boardGuide: the gate on readers, the Stop hook and where a measure is drawn", () => {
  it("counts neither the owner nor the account gh is signed in as among the collaborators", () => {
    const guide = boardGuide(guideInput());
    expect(guide).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion in the command the guide prints
      'ME=$(gh api user --jq .login) && gh api "repos/$SLUG/collaborators?affiliation=all" --jq "[.[] | select(.login != \\"${SLUG%%/*}\\" and .login != \\"$ME\\")] | length"',
    );
    expect(guide).toContain(
      "It should print PRIVATE, 0 and 0: neither the owner nor you is counted, so a repo an organization owns prints 0 too when no one else can read it.",
    );
  });

  it("puts its own rule before a Stop hook's ask between measure and record", () => {
    expect(boardGuide(guideInput())).toContain(
      "- A Stop hook may ask you, as a turn ends, to capture decisions or a note. From the measure of step 2 to the record of step 7, write nothing it asks for: say that the board is between its measure and its record. After step 7, capture what is worth capturing. This rule comes first while a board is being judged.",
    );
  });

  it("says, before a board is declared, which measures the page draws and who may read the repo", () => {
    const guide = boardGuide(guideInput({ board: { status: "undeclared" } }));
    expect(guide).toContain(
      "Every measure is drawn in the board page's table of measures, and one with `lane:` (a lane id, or a list of them) in each of those lanes' sections too.",
    );
    expect(guide).toContain(
      "no collaborator but the owner and you (the account gh is signed in as), and no invitation",
    );
  });
});

describe("boardGuide: an observation not made, the milestones, isolation and what cannot be confirmed", () => {
  it("says an observation not made still takes the time it was tried, as record requires", () => {
    const d = declaration();
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
    expect(guide).toContain(
      'write `"value": null` and an `"error"` saying why, and still the `observed_at` of when you tried: record refuses one left empty.',
    );
    expect(guide).toContain(
      "With no answer this time, write a null, say so as the error, and give the time you asked as `observed_at`.",
    );
    expect(guide).toContain(
      'one not made has `"value": null`, an `error` and the `observed_at` of when it was tried. The template leaves each `observed_at` empty: fill every one.',
    );
    // What the guide says is so: with only the error added, record refuses
    // the observed_at the template left empty; with the time, it takes it.
    const template = templateIn(guide);
    template.measure_digest = `sha256:${"a".repeat(64)}`;
    template.cells = (template.cells as Record<string, unknown>[]).map((cell) => ({
      ...cell,
      state: "none",
    }));
    (template.judged_by as Record<string, unknown>).model = "Claude Opus 5.5";
    const observed = template.observed as Record<string, Record<string, unknown>>;
    for (const o of Object.values(observed)) o.error = "no answer this time";
    const refused = parseRecordInput(template, d);
    expect(refused.ok ? [] : refused.errors).toEqual(
      d.observe.map(
        (o) =>
          `observed.${o.key}.observed_at: must be a calendar date (YYYY-MM-DD), or one with a time of day and its offset`,
      ),
    );
    for (const o of Object.values(observed)) o.observed_at = "2026-10-09T03:00:00Z";
    const taken = parseRecordInput(template, d);
    expect(taken.ok ? [] : taken.errors).toEqual([]);
  });

  it("says how many milestones are declared and what one holds", () => {
    const withMilestones = (n: number) =>
      boardGuide(
        guideInput({
          board: {
            status: "declared",
            declaration: declaration({
              effort: {
                start: "2026-04-28",
                time_zone: "UTC",
                milestones: Array.from({ length: n }, (_, i) => ({
                  date: `2026-05-0${i + 1}`,
                  label: `v0.${i + 1}.0`,
                  ref: `tag v0.${i + 1}.0`,
                })),
              },
            }),
            recordCount: 0,
            previous: NO_PREVIOUS_RECORDS,
          },
        }),
      );
    const holds =
      "under effort.milestones, each `{ date, label, ref }`: only days on which something happened (a release, a launch, the start of the work), never a plan or a target date, each with `ref` saying where it can be checked (a tag and its commit, or a decision id in full). `date` is the day in the board's time zone (effort.time_zone, or this host's when it declares none); .basou/decisions.md dates a decision by its day in UTC, which can be a day apart. The page marks them on the period and effort chart from the next record on: a record draws the declaration it kept. Add one with the operator's approval, before the measure of step 2 or after the record of step 7, never between: the digest covers board.yaml.";
    expect(boardGuide(guideInput())).toContain(`- Milestones: none declared ${holds}`);
    expect(boardGuide(guideInput())).toContain(
      "- Approving a milestone before it is added to board.yaml.",
    );
    expect(withMilestones(0)).toContain(`- Milestones: none declared ${holds}`);
    expect(withMilestones(1)).toContain(`- Milestones: 1 milestone declared ${holds}`);
    expect(withMilestones(2)).toContain(`- Milestones: 2 milestones declared ${holds}`);
    const undeclared = boardGuide(guideInput({ board: { status: "undeclared" } }));
    expect(undeclared).toContain(
      "Declare under `effort.milestones` the days to mark on the period and effort chart: only days on which something happened (a release, a launch, the start of the work), each with a `ref` saying where it can be checked, never a plan or a target date, its `date` the day in the board's time zone (.basou/decisions.md dates a decision by its day in UTC); a board moved from another keeps there the milestones it had that happened, and leaves out any that were only planned.",
    );
    // Neither says only what was reached: the start of the work is a milestone too.
    expect(boardGuide(guideInput())).not.toContain("only what was reached");
    expect(undeclared).not.toContain("only what was reached");
  });

  it("keeps other projects out of what the agent writes, and says the portfolio section is basou's own", () => {
    expect(boardGuide(guideInput())).toContain(
      "Do not bring other projects' names, paths, numbers or ids into what you write for the board (board.yaml, the prose, the reasons, the observations), nor take this one's out (record refuses an input whose words name another workspace the portfolio registers, and says where without naming it). The record's `portfolio` section is basou's own measure: how many workspaces this machine's portfolio registers, with no names.",
    );
  });

  it("gives what only the operator can see to unverified, and a screen checked every time to a manual observation", () => {
    expect(boardGuide(guideInput())).toContain(
      "- `unverified` (?): you cannot confirm it from where you judge: a run only another workspace can make, or a screen only the operator can see and did not check this time. Needs a reason saying who or what could confirm it. Not when this board could check it and you did not: measure it, or say in a footnote why not. When the operator did check, judge by what they saw. A screen the operator would check at every record is better declared as a `manual` observation (through step 2b): their answer is then kept in the record",
    );
  });
});

describe("boardGuide: no board declared", () => {
  it("asks to keep board/ out of a public site or package built from this repo", () => {
    expect(boardGuide(guideInput({ board: { status: "undeclared" } }))).toContain(
      "Never keep a board in a repo shared with a client. When this repo is also what a public site or package is built from, check too that board/ stays out of what is built and published (a generator that copies the repo's root into the site publishes the records); when it cannot be checked, ask the operator before going on.",
    );
  });

  it("says how to declare one instead of the steps", () => {
    const guide = boardGuide(guideInput({ board: { status: "undeclared" } }));
    expect(guide).toContain("## No board is declared yet");
    expect(guide).toContain(BOARD_INIT_SAVE);
    expect(guide).toContain("basou: `'/usr/bin/node' '/opt/basou/index.js'` printed this.");
    expect(guide).toContain("Run `basou board guide` again");
    expect(guide).not.toContain("## Steps");
    expect(guide).not.toContain("```json");
  });

  it("says a directory no built-in marker finds is registered with a marker of its own", () => {
    expect(boardGuide(guideInput({ board: { status: "undeclared" } }))).toContain(
      "A directory no built-in marker finds (content, scripts) is registered with a `marker` of its own: a glob, from it, of the files that mark it.",
    );
  });

  it("says where the keys of each kind are described, for this basou's version, with a board or without", () => {
    const reference =
      "The keys each kind of measure and observation takes at each `board_version`, their defaults and the shapes of their values are described in the reference for basou 0.0.0-test: https://github.com/basou-dev/basou/blob/v0.0.0-test/docs/spec/board.md. A key that no `board_version` of its kind takes is refused with the keys the kind takes; one a later version takes is told which version reads it.";
    // When the axis is cut, before a board is declared.
    const undeclared = boardGuide(guideInput({ board: { status: "undeclared" } }));
    expect(undeclared).toContain(`\n   ${reference}\n4. Check it until it reads`);
    // When the axis is reviewed, before the proposal is applied.
    const declared = boardGuide(guideInput());
    expect(declared).toContain(`\n\n${reference}\n\nApply nothing until the operator approves.`);
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

  it("saves the board init prints only where no board is, leaving nothing else behind", async () => {
    const anchor = join(dir, "ws");
    const bin = join(dir, "bin");
    await mkdir(anchor);
    await mkdir(bin);
    // A basou that prints a board, as init does, or fails as init does.
    const basou = join(bin, "basou");
    const prints = "#!/bin/sh\necho 'title: printed'\n";
    await writeFile(basou, prints, { mode: 0o755 });
    const guide = boardGuide(guideInput({ anchor, board: { status: "undeclared" } }));
    const save = blocksIn(guide).find((b) => b.includes("basou board init")) as string;
    const env = { ...process.env, TMPDIR: dir, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const run = () => execFileSync("sh", ["-c", save], { env, encoding: "utf8" });
    await writeFile(basou, "#!/bin/sh\necho 'refused' >&2; exit 1\n", { mode: 0o755 });
    expect(run()).toBe("exit=1\n");
    await expect(readdir(anchor)).resolves.toEqual([]);
    await writeFile(basou, prints, { mode: 0o755 });
    expect(run()).toBe("exit=0\n");
    expect(await readdir(join(anchor, "board"))).toEqual(["board.yaml"]);
    expect(await readFile(join(anchor, "board", "board.yaml"), "utf8")).toBe("title: printed\n");
    await writeFile(join(anchor, "board", "board.yaml"), "title: mine\n");
    expect(run()).toBe("exit=1\n");
    expect(await readdir(join(anchor, "board"))).toEqual(["board.yaml"]);
    expect(await readFile(join(anchor, "board", "board.yaml"), "utf8")).toBe("title: mine\n");
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

// The board of a guide's input: declared, with no record yet.
function declared(d: BoardDeclaration): BoardGuideInput["board"] {
  return { status: "declared", declaration: d, recordCount: 0, previous: NO_PREVIOUS_RECORDS };
}

// A board of version 3 whose observations are `observe`.
function httpDeclaration(observe: Record<string, unknown>[]): BoardDeclaration {
  return declaration({ board_version: 3, observe });
}

const SHOP = "https://example.com/shop/item-1";
const IN_STOCK = "\u5728\u5eab\u3042\u308a";

describe("boardGuide: an http observation", () => {
  const full = {
    key: "shop",
    kind: "http",
    url: SHOP,
    words: ["in stock", IN_STOCK, "AT&T"],
    count_pattern: "<loc>",
    capture_pattern: "Version ([0-9.]+)",
  };

  it("writes the script once, then gives each observation one block: the GET, its status line and exit code kept in W, and the script with what it reads after --, quoted", () => {
    const guide = boardGuide(
      guideInput({
        board: declared(httpDeclaration([full, { key: "bare", kind: "http", url: SHOP }])),
      }),
    );
    const blocks = blocksIn(guide);
    const writes = blocks.filter((b) => b.includes("printf '%s\\n' '"));
    expect(writes).toHaveLength(1);
    const write = writes[0] as string;
    const script = write.slice(write.indexOf("printf '%s\\n' '") + 15, write.indexOf("' > \"$W/"));
    // One single-quoted word: nothing in it ends the quotation or escapes.
    expect(script).not.toMatch(/['\\]/);
    const file = /> "\$W\/(http-read-[0-9a-f]{12}\.cjs)"; echo "exit=\$\?"$/.exec(write)?.[1];
    expect(file).toBeDefined();
    expect(blocks.indexOf(write)).toBeLessThan(blocks.findIndex((b) => b.includes("curl -sS")));
    const get = blocks.find((b) => b.includes('"$W/http-shop.body"')) as string;
    expect(get).toMatch(/^cd .* && \{ rm -f "\$W\/http-shop\.body"; curl /);
    expect(get).toContain(
      `curl -sS -L --max-redirs 10 --max-time 20 -o "$W/http-shop.body" -w '%{http_code} %{num_redirects} %{url_effective}\\n' '${SHOP}' > "$W/http-shop.meta"; echo "$?" > "$W/http-shop.exit"; node "$W/${file}" -- "$W/http-shop" '${SHOP}' '<loc>' 'Version ([0-9.]+)' 'in stock' '${IN_STOCK}' 'AT&T'; }; echo "exit=$?"`,
    );
    // No -f: a 4xx or 5xx is a status, not a failure.
    expect(get.slice(get.indexOf("curl "), get.indexOf(' > "$W/http-shop.meta"'))).not.toMatch(
      / -f|-fsS/,
    );
    const bare = blocks.find((b) => b.includes('"$W/http-bare.body"')) as string;
    expect(bare).toContain(` -- "$W/http-bare" '${SHOP}' '' ''; }; echo "exit=$?"`);
    expect(guide).toContain("#### `shop` (http)");
    expect(guide).toContain(
      `A GET of \`${SHOP}\`, reading off a 2xx body \`words\` \`in stock\`, \`${IN_STOCK}\`, \`AT&T\`, \`count\` of \`<loc>\`, \`capture\` of \`Version ([0-9.]+)\`:`,
    );
    expect(guide).toContain(`A GET of \`${SHOP}\`:`);
    expect(guide).toContain(`Put the line it prints under \`shop\` as it is. Source: \`${SHOP}\`.`);
    // What the kind gives is said once, for both.
    expect(guide.split("- `http`: ")).toHaveLength(2);
    expect(guide).toContain("- `http`: a GET, following up to 10 redirects, with no `-f`");
    expect(guide).toContain("not line by line as a measure's `pattern` is");
    expect(guide).toContain(
      "The value holds `status`, `redirects` and `final_url` (the URL it ended at, with no user, query or fragment: they can carry a token that changes each time, and record refuses a `final_url` that has one; a token in the path itself, such as `;jsessionid=`, is kept, so make an observation that ends at such a URL `manual` instead)",
    );
    expect(guide).toContain(
      "When the status is not 2xx the body is not read, and each read is a null, not a list of nulls",
    );
    expect(guide).toContain(
      "more than 10 redirects: exit 47), its status is not one of an HTTP response (100 to 599, such as a server answering 600), the URL it ended at is not an http or https one, or the body cannot be read",
    );
    expect(guide).toContain(
      "record refuses another, such as a number given as a string, a string with a space or a line break at either end, or an `http` status that is not a response's (100 to 599)",
    );
    const observed = templateIn(guide).observed as Record<string, { source: string }>;
    expect(observed.shop?.source).toBe(SHOP);
  });

  it("writes a word or a pattern as Markdown code that shows it as it is, backquotes and spaces too", () => {
    const guide = boardGuide(
      guideInput({
        board: declared(
          httpDeclaration([
            {
              key: "odd",
              kind: "http",
              url: SHOP,
              words: ["a`b", " in stock ", "``x"],
              count_pattern: "<loc>|`",
            },
          ]),
        ),
      }),
    );
    expect(guide).toContain(
      "reading off a 2xx body `words` ``a`b``, `  in stock  `, ``` ``x ```, `count` of `` <loc>|` ``:",
    );
  });

  it("says what each kind gives once, whatever the number of its observations", () => {
    const guide = boardGuide(
      guideInput({
        board: declared(
          httpDeclaration([
            { key: "a", kind: "github_check", repo: "o/n", check: "a" },
            { key: "b", kind: "github_check", repo: "o/n", check: "b" },
            { key: "c", kind: "manual", how: "ask" },
          ]),
        ),
      }),
    );
    expect(guide.split("- `github_check`: ")).toHaveLength(2);
    expect(guide.split("- `manual`: ")).toHaveLength(2);
    expect(guide).not.toContain("- `http`: ");
    expect(guide).not.toContain("printf '%s\\n'");
  });
});

describe("boardGuide: an http observation, run", () => {
  let dir: string;
  let origin: string;
  let server: ReturnType<typeof createServer>;
  const bodies = new Map<string, string>();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-board-http-"));
    bodies.clear();
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/moved") res.writeHead(301, { location: "/body/item" }).end();
      else if (url === "/signin") {
        res.writeHead(302, { location: "/login?next=%2Fshop&token=a1b2c3" }).end();
      } else if (url.startsWith("/login?")) res.writeHead(200).end("sign in");
      else if (url.startsWith("/loop")) {
        res.writeHead(302, { location: `/loop${(url.length % 50) + 1}` }).end();
      } else if (url === "/empty") res.writeHead(204).end();
      else if (url.startsWith("/body/") && bodies.has(url.slice(6))) {
        res.writeHead(200, { "content-type": "text/html" }).end(bodies.get(url.slice(6)));
      } else if (url.startsWith("/status/")) res.writeHead(Number(url.slice(8))).end("x");
      // A body that a read of it, which a status not 2xx must not make, would find x in.
      else res.writeHead(404).end("not here, x");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  // Run a block of the guide in a shell, with W under dir, and no proxy.
  const run = (script: string) =>
    new Promise<{ out: string; err: string }>((resolve) => {
      execFile(
        "sh",
        ["-c", script],
        { env: { ...process.env, TMPDIR: dir, NO_PROXY: "*", no_proxy: "*" }, encoding: "utf8" },
        (_error, out, err) => resolve({ out, err }),
      );
    });

  // The guide for these observations, its script written to W; then each
  // observation's block, run with its URL pointed at `path` of the server,
  // gives the entry it prints.
  const observe = async (observations: Record<string, unknown>[]) => {
    const guide = boardGuide(
      guideInput({ anchor: dir, board: declared(httpDeclaration(observations)) }),
    );
    const blocks = blocksIn(guide);
    const write = blocks.find((b) => b.includes("printf '%s\\n' '")) as string;
    expect(await run(write)).toEqual({ out: "exit=0\n", err: "" });
    const declaration = httpDeclaration(observations);
    return async (key: string, path: string) => {
      const block = blocks.find((b) => b.includes(`"$W/http-${key}.body"`)) as string;
      const { out } = await run(block.replaceAll(`'${SHOP}'`, `'${origin}${path}'`));
      const [entry, exit] = out.split("\n");
      expect(exit).toBe("exit=0");
      const parsed = JSON.parse(entry as string) as {
        value: unknown;
        observed_at: string;
        source: string;
        error?: string;
      };
      expect(parsed.source).toBe(`${origin}${path}`);
      expect(parsed.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // What it prints is what record takes.
      const o = declaration.observe.find((x) => x.key === key) as BoardObserve;
      if (parsed.value !== null) expect(observedValueProblems(o, parsed.value)).toEqual([]);
      return parsed;
    };
  };

  it("reads the words, the count and the capture off the whole 2xx body, decoded once and without its BOM", async () => {
    const get = await observe([
      {
        key: "shop",
        kind: "http",
        url: SHOP,
        // Found as written: not ignoring case, and at the body's start too.
        words: [IN_STOCK, "sold out", "AT&T", "<urlset>", "VERSION 2.3"],
        count_pattern: "^<urlset>|<loc>",
        capture_pattern: "Version ([0-9.]+)",
      },
      { key: "opt", kind: "http", url: SHOP, capture_pattern: "x(y)?" },
      // Under the u flag . is one character, not one half of a surrogate pair.
      { key: "flags", kind: "http", url: SHOP, count_pattern: ".", capture_pattern: "(.)" },
      // Only a BOM at the start is taken off.
      { key: "bom", kind: "http", url: SHOP, count_pattern: "\\uFEFF" },
    ]);
    // The word starts one byte before 64 KiB (after the 3 bytes of the BOM
    // and the 8 of <urlset>), so a chunk of a stream would cut it.
    bodies.set(
      "item",
      `\ufeff<urlset>${"a".repeat(65535 - 3 - 8)}${IN_STOCK} AT&amp;T <loc>1</loc><loc>2</loc> Version 2.3 and Version 9.9`,
    );
    expect((await get("shop", "/moved")).value).toEqual({
      status: 200,
      redirects: 1,
      final_url: `${origin}/body/item`,
      words: [true, false, false, true, false],
      count: 3,
      capture: "2.3",
    });
    bodies.set("item", "nothing here");
    expect((await get("shop", "/body/item")).value).toEqual({
      status: 200,
      redirects: 0,
      final_url: `${origin}/body/item`,
      words: [false, false, false, false, false],
      count: 0,
      capture: null,
    });
    // A group that took no part in the match gives null, as no match does.
    bodies.set("x", "x");
    expect((await get("opt", "/body/x")).value).toMatchObject({ capture: null });
    bodies.set("emoji", "\u{1F600}");
    expect((await get("flags", "/body/emoji")).value).toMatchObject({
      count: 1,
      capture: "\u{1F600}",
    });
    bodies.set("bom", "\ufeffa\ufeffb");
    expect((await get("bom", "/body/bom")).value).toMatchObject({ count: 1 });
  });

  it("gives a status not 2xx as a value whose reads are null, and an empty body as empty", async () => {
    const get = await observe([
      {
        key: "shop",
        kind: "http",
        url: SHOP,
        words: ["x"],
        count_pattern: "x",
        capture_pattern: "(x)",
      },
    ]);
    expect((await get("shop", "/gone")).value).toEqual({
      status: 404,
      redirects: 0,
      final_url: `${origin}/gone`,
      words: null,
      count: null,
      capture: null,
    });
    expect((await get("shop", "/empty")).value).toEqual({
      status: 204,
      redirects: 0,
      final_url: `${origin}/empty`,
      words: [false],
      count: 0,
      capture: null,
    });
  });

  it("gives no value but the error when curl fails: past 10 redirects, or no connection", async () => {
    const get = await observe([{ key: "shop", kind: "http", url: SHOP }]);
    expect(await get("shop", "/loop")).toMatchObject({
      value: null,
      error: "curl exit 47: more than 10 redirects",
    });
    // A port nothing listens on: curl prints the status 000 and exits 7.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const guide = boardGuide(
      guideInput({
        anchor: dir,
        board: declared(httpDeclaration([{ key: "shop", kind: "http", url: SHOP }])),
      }),
    );
    const block = blocksIn(guide).find((b) => b.includes('"$W/http-shop.body"')) as string;
    const { out } = await run(block.replaceAll(`'${SHOP}'`, `'http://127.0.0.1:${port}/x'`));
    expect(JSON.parse(out.split("\n")[0] as string)).toMatchObject({
      value: null,
      error: "curl exit 7: no connection",
    });
  });

  it("reads a body at 299 and not at 300, and gives no value for a status no response has", async () => {
    const get = await observe([
      {
        key: "shop",
        kind: "http",
        url: SHOP,
        words: ["x"],
        count_pattern: "x",
        capture_pattern: "(x)",
      },
    ]);
    expect((await get("shop", "/status/299")).value).toEqual({
      status: 299,
      redirects: 0,
      final_url: `${origin}/status/299`,
      words: [true],
      count: 1,
      capture: "x",
    });
    expect((await get("shop", "/status/300")).value).toEqual({
      status: 300,
      redirects: 0,
      final_url: `${origin}/status/300`,
      words: null,
      count: null,
      capture: null,
    });
    // curl prints what the server answers, and exits 0.
    expect(await get("shop", "/status/600")).toMatchObject({
      value: null,
      error: "the status 600 is not one of an HTTP response (100 to 599)",
    });
  });

  it("escapes in its line what a terminal would act on or hide, and keeps the value", async () => {
    const get = await observe([
      { key: "shop", kind: "http", url: SHOP, capture_pattern: "Version ([^<]+)" },
    ]);
    const odd = `1${String.fromCodePoint(0x2028)} 2${String.fromCodePoint(0x202e)}evil${String.fromCodePoint(0x85)}`;
    bodies.set("odd", `Version ${odd}<`);
    const guide = boardGuide(
      guideInput({
        anchor: dir,
        board: declared(
          httpDeclaration([
            { key: "shop", kind: "http", url: SHOP, capture_pattern: "Version ([^<]+)" },
          ]),
        ),
      }),
    );
    const block = blocksIn(guide).find((b) => b.includes('"$W/http-shop.body"')) as string;
    const { out } = await run(block.replaceAll(`'${SHOP}'`, `'${origin}/body/odd'`));
    expect(out.split("\n")).toHaveLength(3);
    for (const code of [0x2028, 0x202e, 0x85]) {
      expect(out.includes(String.fromCodePoint(code)), code.toString(16)).toBe(false);
    }
    expect(out).toContain("\\u2028");
    expect((await get("shop", "/body/odd")).value).toMatchObject({ capture: odd });
  });

  it("gives no value when what curl left in W cannot be read", async () => {
    const guide = boardGuide(
      guideInput({
        anchor: dir,
        board: declared(httpDeclaration([{ key: "shop", kind: "http", url: SHOP }])),
      }),
    );
    const write = blocksIn(guide).find((b) => b.includes("printf '%s\\n' '")) as string;
    expect((await run(write)).out).toBe("exit=0\n");
    const file = /"\$W\/(http-read-[0-9a-f]{12}\.cjs)"/.exec(write)?.[1] as string;
    const work = boardGuideWorkDir(dir).replace(TMPDIR_WORD, dir);
    const out = execFileSync(
      "node",
      [join(work, file), "--", join(work, "http-none"), SHOP, "", ""],
      { encoding: "utf8" },
    );
    expect(JSON.parse(out)).toMatchObject({
      value: null,
      source: SHOP,
      error: "what curl left in W could not be read",
    });
  });

  it("keeps of the URL it ended at only the scheme, the host and the path: a sign-in's token is left out", async () => {
    const get = await observe([{ key: "shop", kind: "http", url: SHOP, words: ["sign in"] }]);
    const entry = await get("shop", "/signin");
    expect(entry.value).toEqual({
      status: 200,
      redirects: 1,
      final_url: `${origin}/login`,
      words: [true],
    });
    expect(JSON.stringify(entry)).not.toContain("a1b2c3");
  });

  it("leaves a user, a query and a fragment out of the URL curl printed, and gives no value for one that is no http or https URL", async () => {
    const guide = boardGuide(
      guideInput({
        anchor: dir,
        board: declared(httpDeclaration([{ key: "shop", kind: "http", url: SHOP }])),
      }),
    );
    const write = blocksIn(guide).find((b) => b.includes("printf '%s\\n' '")) as string;
    expect((await run(write)).out).toBe("exit=0\n");
    const file = /"\$W\/(http-read-[0-9a-f]{12}\.cjs)"/.exec(write)?.[1] as string;
    const work = boardGuideWorkDir(dir).replace(TMPDIR_WORD, dir);
    // The script on what curl would leave: exit 0 and this status line.
    const read = async (meta: string) => {
      await writeFile(join(work, "http-x.exit"), "0\n");
      await writeFile(join(work, "http-x.meta"), `${meta}\n`);
      const out = execFileSync(
        "node",
        [join(work, file), "--", join(work, "http-x"), SHOP, "", ""],
        {
          encoding: "utf8",
        },
      );
      return JSON.parse(out) as { value: { final_url?: string } | null; error?: string };
    };
    for (const [meta, finalUrl] of [
      [
        "200 0 https://user:secret@example.com:8443/a/b%3Fc?token=x#frag",
        "https://example.com:8443/a/b%3Fc",
      ],
      ["200 1 https://example.com:443/login?state=1", "https://example.com/login"],
      ["301 10 http://example.com#top", "http://example.com/"],
    ] as const) {
      const entry = await read(meta);
      expect(entry.value?.final_url, meta).toBe(finalUrl);
      const o = httpDeclaration([{ key: "shop", kind: "http", url: SHOP }])
        .observe[0] as BoardObserve;
      expect(observedValueProblems(o, entry.value)).toEqual([]);
    }
    for (const meta of [
      "200 0 not a url",
      "200 0 /login",
      "200 0 ftp://example.com/x?token=secret",
    ]) {
      const entry = await read(meta);
      expect(entry, meta).toMatchObject({
        value: null,
        error: "the URL curl ended at is not an absolute http or https URL",
      });
      expect(JSON.stringify(entry)).not.toContain("secret");
    }
  });

  it("gives no value when the count_pattern matches an empty string the declaration could not see", async () => {
    const get = await observe([{ key: "edge", kind: "http", url: SHOP, count_pattern: "\\b" }]);
    bodies.set("ab", "a b");
    expect(await get("edge", "/body/ab")).toMatchObject({
      value: null,
      error: "the count_pattern matched an empty string at 0",
    });
  });
});

const ODD_CHECK = 'Workers Builds: a`b $(touch x) "c"; \u30c7\u30d7\u30ed\u30a4';
const CHECK_STATE =
  '(.check_runs | max_by(.id) | if .status == "completed" then .conclusion else .status end), (if .total_count > 100 then "more than 100 runs: \\(.total_count)" else empty end)';

describe("boardGuide: a github_check observation and an observation's notes", () => {
  it("asks for the newest check run of that name on the head of the branch, quoted, with its value and source", () => {
    const guide = boardGuide(
      guideInput({
        board: declared(
          httpDeclaration([
            {
              key: "deploy",
              kind: "github_check",
              repo: "owner/name",
              check: "Workers Builds: app",
            },
            {
              key: "odd",
              kind: "github_check",
              repo: "owner/name.js",
              check: ODD_CHECK,
              branch: "release/1.x",
            },
          ]),
        ),
      }),
    );
    const blocks = blocksIn(guide);
    expect(blocks).toContain(
      `gh api -X GET 'repos/owner/name/commits/heads/main/check-runs' -f check_name='Workers Builds: app' -f per_page=100 -q '${CHECK_STATE}'; echo "exit=$?"`,
    );
    expect(blocks).toContain(
      `gh api -X GET 'repos/owner/name.js/commits/heads/release/1.x/check-runs' -f check_name='${ODD_CHECK}' -f per_page=100 -q '${CHECK_STATE}'; echo "exit=$?"`,
    );
    const deploy = guide.slice(
      guide.indexOf("#### `deploy` (github_check)"),
      guide.indexOf("#### `odd`"),
    );
    expect(deploy).toContain(
      "How the latest check run named `Workers Builds: app` on the head commit of `main` of `owner/name` ended",
    );
    // What the kind gives is said once, before the observations.
    const kind = guide.slice(guide.indexOf("- `github_check`: "), guide.indexOf("#### `deploy`"));
    expect(kind).toContain(
      "Value: the first line it prints, as a string (`success`, `failure`, `cancelled`, `skipped`, or the status of a run not finished, such as `queued` or `in_progress`). A second line, `more than 100 runs: <n>`, says the newest run may be on a page not read: keep the first line as the value, and say so in a footnote.",
    );
    expect(kind).toContain(
      "An empty line is no check run of that name on the head commit: a null, with the error saying so.",
    );
    expect(kind).toContain(
      "A head commit that never started the check (a path filter, `[skip ci]` in its commit message, or the app's own rules) gives this too, even when what the check looks after is fine; a job a workflow skipped with `if:` is a check run, concluded `skipped`.",
    );
    expect(kind).toContain("A branch that does not exist exits 1 (HTTP 422)");
    expect(deploy).toContain(
      "An empty line: the head commit of `main` has no check run named `Workers Builds: app`.",
    );
    expect(deploy).toContain(
      "Source: `gh api -X GET repos/owner/name/commits/heads/main/check-runs -f check_name='Workers Builds: app'`.",
    );
    // A name with a backquote is still Markdown code as it is, in the prose as in the source.
    const odd = guide.slice(guide.indexOf("#### `odd` (github_check)"), guide.indexOf("### 4."));
    expect(odd).toContain(
      `How the latest check run named \`\`${ODD_CHECK}\`\` on the head commit of \`release/1.x\` of \`owner/name.js\` ended`,
    );
    expect(odd).toContain(
      `the head commit of \`release/1.x\` has no check run named \`\`${ODD_CHECK}\`\`.`,
    );
    expect(odd).toContain(
      `Source: \`\`gh api -X GET repos/owner/name.js/commits/heads/release/1.x/check-runs -f check_name='${ODD_CHECK}'\`\`.`,
    );
    const observed = templateIn(guide).observed as Record<string, { source: string }>;
    expect(observed.deploy?.source).toBe(
      "gh api -X GET repos/owner/name/commits/heads/main/check-runs -f check_name='Workers Builds: app'",
    );
    expect(observed.odd?.source).toBe(
      `gh api -X GET repos/owner/name.js/commits/heads/release/1.x/check-runs -f check_name='${ODD_CHECK}'`,
    );
  });

  it("gives the check name to gh as one argument, whatever it holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basou-board-check-"));
    try {
      const bin = join(dir, "bin");
      await mkdir(bin);
      // A gh that prints each argument it is given on a line of its own.
      await writeFile(
        join(bin, "gh"),
        '#!/bin/sh\nfor a in "$@"; do printf \'[%s]\\n\' "$a"; done\n',
        {
          mode: 0o755,
        },
      );
      const guide = boardGuide(
        guideInput({
          anchor: dir,
          board: declared(
            httpDeclaration([
              { key: "odd", kind: "github_check", repo: "o/n", check: ODD_CHECK, branch: "a/b" },
            ]),
          ),
        }),
      );
      const ask = blocksIn(guide).find((b) => b.startsWith("gh api ")) as string;
      const out = execFileSync("sh", ["-c", ask], {
        cwd: dir,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      expect(out).toBe(
        [
          "[api]",
          "[-X]",
          "[GET]",
          "[repos/o/n/commits/heads/a/b/check-runs]",
          "[-f]",
          `[check_name=${ODD_CHECK}]`,
          "[-f]",
          "[per_page=100]",
          "[-q]",
          `[${CHECK_STATE}]`,
          "exit=0",
          "",
        ].join("\n"),
      );
      await expect(readdir(dir)).resolves.toEqual(["bin"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives as the source the words the command gives gh, quoted only where a shell would read a name otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basou-board-source-"));
    try {
      const bin = join(dir, "bin");
      await mkdir(bin);
      // A gh that prints each argument it is given on a line of its own.
      await writeFile(
        join(bin, "gh"),
        '#!/bin/sh\nfor a in "$@"; do printf \'[%s]\\n\' "$a"; done\n',
        {
          mode: 0o755,
        },
      );
      const observe = [
        { key: "deploy", kind: "github_check", repo: "o/n", check: "Workers Builds: my-app" },
        { key: "odd", kind: "github_check", repo: "o/n.js", check: ODD_CHECK, branch: "a/b" },
        { key: "plain", kind: "github_check", repo: "o/n", check: "build" },
        // What a shell would expand, or zsh would with its own options, though nothing matches here.
        { key: "star", kind: "github_check", repo: "o/n", check: "e2e*" },
        { key: "mark", kind: "github_check", repo: "o/n", check: "a?b" },
        { key: "set", kind: "github_check", repo: "o/n", check: "[x]" },
        { key: "tilde", kind: "github_check", repo: "o/n", check: "~x" },
        { key: "caret", kind: "github_check", repo: "o/n", check: "^x" },
        { key: "ci", kind: "github_ci", repo: "o/n", workflow: "quality.yml", branch: "rel/1.x" },
        { key: "rel", kind: "github_release", repo: "o/n" },
        { key: "iss", kind: "github_open_issues", repo: "o/n" },
        { key: "prs", kind: "github_open_prs", repo: "o/n" },
      ];
      const guide = boardGuide(
        guideInput({ anchor: dir, board: declared(httpDeclaration(observe)) }),
      );
      const sources = templateIn(guide).observed as Record<string, { source: string }>;
      // A plain name reads as it did before.
      expect(sources.plain?.source).toBe(
        "gh api -X GET repos/o/n/commits/heads/main/check-runs -f check_name=build",
      );
      expect(sources.ci?.source).toBe(
        "gh run list --repo o/n --workflow quality.yml --branch rel/1.x",
      );
      expect(sources.deploy?.source).toBe(
        "gh api -X GET repos/o/n/commits/heads/main/check-runs -f check_name='Workers Builds: my-app'",
      );
      for (const [key, check] of [
        ["star", "e2e*"],
        ["mark", "a?b"],
        ["set", "[x]"],
        ["tilde", "~x"],
        ["caret", "^x"],
      ]) {
        expect(sources[key as string]?.source, key).toBe(
          `gh api -X GET repos/o/n/commits/heads/main/check-runs -f check_name='${check}'`,
        );
      }
      const words = (line: string) =>
        execFileSync("sh", ["-c", line], {
          cwd: dir,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
          encoding: "utf8",
        })
          .split("\n")
          .filter((w) => w.startsWith("["));
      // Run as a shell would, each source asks gh what the command asks it,
      // the command going on with what it reads off the answer.
      const blocks = blocksIn(guide).filter((b) => b.startsWith("gh "));
      expect(blocks).toHaveLength(observe.length);
      observe.forEach((o, i) => {
        const source = sources[o.key]?.source as string;
        const asked = words(blocks[i] as string);
        expect(words(source), o.key).toEqual(asked.slice(0, words(source).length));
        expect(words(source).length, o.key).toBeGreaterThan(3);
      });
      expect(words(sources.deploy?.source as string)).toEqual([
        "[api]",
        "[-X]",
        "[GET]",
        "[repos/o/n/commits/heads/main/check-runs]",
        "[-f]",
        "[check_name=Workers Builds: my-app]",
      ]);
      await expect(readdir(dir)).resolves.toEqual(["bin"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists what the board page draws in the order a record's page draws it", () => {
    const guide = boardGuide(
      guideInput({
        board: declared(httpDeclaration([{ key: "shop", kind: "http", url: SHOP }])),
      }),
    );
    const list = guide.slice(
      guide.indexOf("## What the board page draws, and what you write"),
      guide.indexOf("## Do not"),
    );
    const items = list
      .split("\n")
      .filter((line) => /^\d+\. /.test(line))
      .map((line) => line.slice(0, line.indexOf(":")));
    expect(items).toEqual([
      "1. Heading",
      "2. Summary",
      "3. Reach matrix",
      "4. Each lane",
      "5. Observed outside",
      "6. Period and effort",
      "7. Operator's turns",
      "8. Ratios",
      "9. Footnotes",
    ]);
    // The summary draws its tiles; the observations are a section of their own.
    expect(list).toContain("basou draws the tiles.\n");
    expect(list).not.toContain("table of observations");
  });

  it("prints each observation's notes under how it is made, and nothing for one without", () => {
    const guide = boardGuide(
      guideInput({
        board: declared(
          httpDeclaration([
            {
              key: "shop",
              kind: "http",
              url: SHOP,
              notes: ["404 is right while it is sold out", `a${String.fromCodePoint(0x202e)}b`],
            },
            { key: "users", kind: "manual", how: "ask", notes: ["ask on Mondays"] },
            { key: "deploy", kind: "github_check", repo: "o/n", check: "deploy" },
          ]),
        ),
      }),
    );
    const shop = guide.slice(guide.indexOf("#### `shop` (http)"), guide.indexOf("#### `users`"));
    expect(shop).toMatch(
      /Source: `https:\/\/example\.com\/shop\/item-1`\.\n\n- mind: 404 is right while it is sold out\n- mind: a\\u202eb\n\n$/,
    );
    const users = guide.slice(guide.indexOf("#### `users`"), guide.indexOf("#### `deploy`"));
    expect(users).toMatch(
      /Only the operator can make this one: ask\n\n- mind: ask on Mondays\n\n$/,
    );
    const deploy = guide.slice(guide.indexOf("#### `deploy`"), guide.indexOf("### 4."));
    expect(deploy).not.toContain("mind:");
    expect([...guide].some((c) => c.codePointAt(0) === 0x202e)).toBe(false);
  });
});

describe("boardGuide: what a board declares, as code and escaped as the template is", () => {
  it("writes each observation's package, repo, workflow, branch and URL as code, and its source", () => {
    const guide = boardGuide(
      guideInput({
        board: declared(
          httpDeclaration([
            { key: "npm", kind: "npm_version", package: "@scope/a_x_" },
            { key: "rel", kind: "github_release", repo: "o/_x_" },
            { key: "iss", kind: "github_open_issues", repo: "o/_x_" },
            { key: "prs", kind: "github_open_prs", repo: "o/_x_" },
            { key: "ci", kind: "github_ci", repo: "o/_x_", workflow: "_w_.yml", branch: "_b_" },
            { key: "site", kind: "page_version", url: "https://example.com/_x_" },
            { key: "shop", kind: "http", url: "https://example.com/_y_" },
          ]),
        ),
      }),
    );
    for (const line of [
      "The version of `@scope/a_x_` published on npm (its `latest` tag):",
      "The latest release of `o/_x_` on GitHub:",
      "How many issues of `o/_x_` are open:",
      "How many pull requests of `o/_x_` are open:",
      "How the latest run of the workflow `_w_.yml` on `_b_` of `o/_x_` ended:",
      "The version `https://example.com/_x_` shows:",
      "A GET of `https://example.com/_y_`:",
      "Source: `npm view @scope/a_x_ version`.",
      "Source: `gh release view --repo o/_x_`.",
      "Source: `gh issue list --repo o/_x_ --state open`.",
      "Source: `gh pr list --repo o/_x_ --state open`.",
      "Source: `gh run list --repo o/_x_ --workflow _w_.yml --branch _b_`.",
      "Source: `https://example.com/_x_`.",
      "Source: `https://example.com/_y_`.",
    ]) {
      expect(guide, line).toContain(line);
    }
  });

  it("escapes in its prose and sources what its template escapes, and gives the command the name as it is", () => {
    const check = `a${String.fromCharCode(0x200f)}b${String.fromCharCode(0xfeff)}c${String.fromCharCode(0x200b)}d${String.fromCharCode(0x061c)}e${String.fromCharCode(0x2060)}f${String.fromCharCode(0x200e)}g`;
    const shownCheck = "a\\u200fb\\ufeffc\\u200bd\\u061ce\\u2060f\\u200eg";
    const guide = boardGuide(
      guideInput({
        board: declared(
          httpDeclaration([
            { key: "deploy", kind: "github_check", repo: "o/n", check },
            { key: "users", kind: "manual", how: `count${String.fromCharCode(0x200f)}them` },
          ]),
        ),
      }),
    );
    expect(guide).toContain(`How the latest check run named \`${shownCheck}\` on the head commit`);
    expect(guide).toContain(
      `Source: \`gh api -X GET repos/o/n/commits/heads/main/check-runs -f check_name='${shownCheck}'\`.`,
    );
    expect(guide).toContain("Only the operator can make this one: count\\u200fthem");
    // The template says the same, and holds the name itself once read.
    const source = `gh api -X GET repos/o/n/commits/heads/main/check-runs -f check_name='${check}'`;
    expect(guide).toContain(
      `"source":"gh api -X GET repos/o/n/commits/heads/main/check-runs -f check_name='${shownCheck}'"`,
    );
    expect((templateIn(guide).observed as Record<string, { source: string }>).deploy?.source).toBe(
      source,
    );
    // Only the command takes the name as it is.
    const raw = guide.split("\n").filter((l) => l.includes(check));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toContain(
      "gh api -X GET 'repos/o/n/commits/heads/main/check-runs' -f check_name=",
    );
  });
});

describe("boardGuide: every text a board or its records give, escaped as the template is", () => {
  const hid = (code: number) => String.fromCharCode(code);
  // What the guide escapes beyond displayPath, a surrogate not in a pair among it.
  const ESCAPED = [
    0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2062, 0x2069, 0xfeff, 0xdc00,
  ];
  const [ALM, ZWSP, ZWNJ, ZWJ, LRM, RLM, WJ, IT, , BOM, LONE] = ESCAPED.map(hid);
  // Just outside what it escapes: shown as it is.
  const NEXT = [0x061b, 0x200a, 0x2010, 0x206a, 0xfefe, 0xff08].map(hid).join("");

  it("escapes it in every field outside the commands, and leaves what is next to it as it is", () => {
    const d = declaration({
      board_version: 3,
      title: `t${ZWJ}`,
      stages: Object.fromEntries(
        STAGES.map((id) => [
          id,
          id === "01"
            ? { meaning: `m${ZWSP}`, look: [`l${ZWSP}`], notes: [`n${ZWSP}`] }
            : { meaning: id === "02" ? `s${LONE}` : `stage ${id}` },
        ]),
      ),
      lanes: [
        { id: "core", name: `C${ZWJ}`, about: `a${IT}`, notes: [`ln${ALM}`] },
        { id: "docs", name: "Docs", about: `x${NEXT}y` },
      ],
      observe: [
        { key: "deploy", kind: "github_check", repo: "o/n", check: `c${IT}`, notes: [`on${BOM}`] },
        { key: "users", kind: "manual", how: `count${ALM}` },
      ],
      axis: {
        version: 1,
        review_due_days: 60,
        seed_review: { date: "2026-09-28", model: `m${LRM}` },
      },
    });
    const guide = boardGuide(
      guideInput({
        anchor: `/work${RLM}`,
        basouCommand: `basou${WJ}`,
        language: "en",
        board: {
          status: "declared",
          declaration: d,
          recordCount: 1,
          previous: {
            last: { status: "unreadable", reason: `bad${ZWNJ}` },
            lastReview: { status: "none" },
          },
        },
      }),
    );
    for (const line of [
      "- Workspace (its own repo): /work\\u200f",
      '- Declaration: board/board.yaml, "t\\u200d", board_version 3',
      "- Records: board/records/, 1 record; the last cannot be read (bad\\u200c)",
      "last reviewed 2026-09-28 by m\\u200e (seed_review in board.yaml)",
      "The previous record cannot be read (bad\\u200c).",
      "basou: `basou\\u2060` printed this.",
      "- 01: m\\u200b",
      "  - look at: l\\u200b",
      "  - mind: n\\u200b",
      "- 02: s\\udc00",
      "- `core` C\\u200d: a\\u2062",
      "  - mind: ln\\u061c",
      "How the latest check run named `c\\u2062` on the head commit",
      "check_name='c\\u2062'`.",
      "- mind: on\\ufeff",
      "Only the operator can make this one: count\\u061c",
      "  - `users`: count\\u061c",
    ]) {
      expect(guide, line).toContain(line);
    }
    const outsideCommands = guide.replace(/```sh\n[\s\S]*?\n```/g, "");
    for (const c of ESCAPED.map(hid)) {
      expect(outsideCommands.includes(c), c.charCodeAt(0).toString(16)).toBe(false);
    }
    // The command takes the name as it is.
    expect(guide).toContain(`-f check_name='c${IT}'`);
    expect(guide).toContain(`- \`docs\` Docs: x${NEXT}y`);
  });
});
