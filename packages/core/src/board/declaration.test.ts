import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import {
  BOARD_OBSERVE_KINDS,
  type BoardDeclarationResult,
  parseBoardDeclaration,
} from "./declaration.js";

const REPOS = [".", "../basou"];

function stages(): Record<string, { meaning: string }> {
  return Object.fromEntries(
    ["01", "02", "03", "04", "05", "06"].map((id) => [id, { meaning: `stage ${id}` }]),
  );
}

// A board with every required key and one of each optional part.
function board(): Record<string, unknown> {
  return {
    board_version: 1,
    title: "A board",
    stages: stages(),
    lanes: [
      { id: "saddle", name: "Saddle", about: "the workspace", notes: ["06 needs a real run"] },
      { id: "cockpit", name: "Cockpit" },
    ],
    measures: [
      {
        id: "cli_commands",
        kind: "file_count",
        repo: "../basou",
        include: ["packages/cli/src/commands/*.ts"],
        exclude: ["**/*.test.ts"],
        unit: "files",
        lane: "cockpit",
      },
      {
        id: "unreleased_on_main",
        kind: "match_count",
        repo: "../basou",
        include: ["CHANGELOG.md"],
        at: "main",
        section: { start: "^## Unreleased", end: "^## ", on_missing: "zero" },
        pattern: "^- ",
        unit: "entries",
      },
      {
        id: "src_lines",
        kind: "line_count",
        repo: "../basou",
        include: ["**/*.ts"],
        unit: "lines",
      },
      {
        id: "test_lines",
        kind: "line_count",
        repo: "../basou",
        include: ["**/*.test.ts"],
        unit: "lines",
      },
    ],
    ratios: [
      {
        id: "test_to_src",
        label: "tests per source line",
        numerator: "test_lines",
        denominator: "src_lines",
      },
    ],
    components: {
      "basou/packages/sdk": { lane: ["saddle", "cockpit"], note: "the SDK" },
      basou: { lane: "-", note: "the monorepo root" },
    },
    axis: {
      version: 1,
      review_due_days: 60,
      seed_review: { date: "2026-09-28", model: "Claude Opus 5.5" },
    },
    effort: {
      start: "2026-04-28",
      time_zone: "Asia/Tokyo",
      milestones: [{ date: "2026-10-04", label: "v0.64.0", ref: "basou tag v0.64.0 1caea85" }],
    },
  };
}

// The entry `key` of a document (a list index or a mapping key), to change it in place.
function entry(container: unknown, key: number | string): Record<string, unknown> {
  const value = (container as Record<string | number, unknown>)[key];
  if (typeof value !== "object" || value === null) throw new Error(`no entry ${String(key)}`);
  return value as Record<string, unknown>;
}

function parse(doc: unknown, repos: readonly string[] = REPOS): BoardDeclarationResult {
  return parseBoardDeclaration(stringify(doc), { manifestRepoPaths: repos });
}

function errorsOf(result: BoardDeclarationResult): string[] {
  if (result.ok) throw new Error("expected the declaration to be refused");
  return result.errors;
}

// A board whose only measure is `measure`.
function withMeasure(measure: Record<string, unknown>): Record<string, unknown> {
  return { ...board(), measures: [measure], ratios: [] };
}

describe("parseBoardDeclaration: accepted declarations", () => {
  it("accepts a full board and fills each default it applies", () => {
    const result = parse(board());
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const { declaration } = result;
    expect(declaration.title).toBe("A board");
    expect(declaration.lanes.map((l) => l.id)).toEqual(["saddle", "cockpit"]);
    expect(declaration.measures.map((m) => [m.id, "at" in m ? m.at : undefined])).toEqual([
      ["cli_commands", "worktree"],
      ["unreleased_on_main", "main"],
      ["src_lines", "worktree"],
      ["test_lines", "worktree"],
    ]);
    expect(declaration.components["basou/packages/sdk"]?.lane).toEqual(["saddle", "cockpit"]);
  });

  it("reads a board without measures, ratios or components as having none", () => {
    const { measures: _m, ratios: _r, components: _c, ...minimal } = board();
    const result = parse(minimal);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.measures).toEqual([]);
    expect(result.declaration.ratios).toEqual([]);
    expect(result.declaration.components).toEqual({});
  });

  it("accepts each kind of measure with its optional keys", () => {
    const measures = [
      { id: "a", kind: "file_count", repo: ".", include: ["docs/*.md"], unit: "files" },
      {
        id: "b",
        kind: "dir_count",
        repo: "../basou",
        path: "packages/core/src",
        depth: 1,
        include: ["**/*.ts"],
        exclude: ["**/*.test.ts"],
        unit: "dirs",
      },
      { id: "c", kind: "line_count", repo: ".", include: ["**/*.md"], at: "HEAD~1", unit: "lines" },
      {
        id: "d",
        kind: "match_count",
        repo: ".",
        include: ["*.md"],
        pattern: "^\\s*it\\(",
        section: { start: "^## A", on_missing: null },
        unit: "matching_lines",
      },
      {
        id: "e",
        kind: "regex_capture",
        repo: "../basou",
        file: "CHANGELOG.md",
        pattern: "^## ([0-9][^ ]*)",
        unit: "version",
      },
      {
        id: "f",
        kind: "regex_capture",
        repo: ".",
        file: "a.md",
        pattern: "^v\\d+",
        group: 0,
        unit: "tag",
      },
      {
        id: "g",
        kind: "json_length",
        repo: "../basou",
        file: "package.json",
        pointer: "/files",
        unit: "items",
      },
      { id: "h", kind: "json_length", repo: ".", file: "x.json", pointer: "", unit: "items" },
      { id: "i", kind: "trail_count", of: "decisions_live", unit: "decisions" },
      { id: "j", kind: "trail_count", of: "tasks", status: "in_progress", unit: "tasks" },
    ];
    const result = parse({ ...board(), measures, ratios: [] });
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const capture = result.declaration.measures.filter((m) => m.kind === "regex_capture");
    expect(capture.map((m) => [m.id, m.group])).toEqual([
      ["e", 1],
      ["f", 0],
    ]);
  });
});

describe("parseBoardDeclaration: board_version", () => {
  it("stops at an unknown board_version, naming it, whatever else is wrong", () => {
    expect(errorsOf(parse({ ...board(), board_version: 4, title: "", extra: 1 }))).toEqual([
      "board_version: this basou reads board_version 1, 2 or 3, not 4",
    ]);
  });

  it("refuses a board_version that is missing or not a number", () => {
    const { board_version: _v, ...missing } = board();
    const reads = "board_version: must be a board version this basou reads (1, 2 or 3)";
    expect(errorsOf(parse(missing))).toEqual([reads]);
    expect(errorsOf(parse({ ...board(), board_version: "1" }))).toEqual([reads]);
  });
});

describe("parseBoardDeclaration: the shape of each key", () => {
  it("refuses an unknown key at every level", () => {
    const doc = board();
    doc.extra = 1;
    entry(doc.lanes, 0).colour = "red";
    entry(doc.stages, "03").note = "x";
    entry(doc.measures, 1).section = {
      start: "^## Unreleased",
      on_missing: "zero",
      stop: "x",
    };
    (doc.axis as Record<string, unknown>).due = 1;
    expect(errorsOf(parse(doc))).toEqual([
      "stages.03: unknown key 'note'",
      "lanes[0]: unknown key 'colour'",
      "measures[1].section: unknown key 'stop'",
      "axis: unknown key 'due'",
      "(top level): unknown key 'extra'",
    ]);
  });

  it("refuses missing required keys", () => {
    const { title: _t, axis: _a, effort: _e, ...doc } = board();
    expect(errorsOf(parse(doc))).toEqual([
      "title: Invalid input: expected string, received undefined",
      "axis: Invalid input: expected object, received undefined",
      "effort: Invalid input: expected object, received undefined",
    ]);
  });

  it("requires all six stages and no other", () => {
    const missing = stages();
    delete missing["06"];
    expect(errorsOf(parse({ ...board(), stages: missing }))).toEqual([
      "stages.06: Invalid input: expected object, received undefined",
    ]);
    expect(
      errorsOf(parse({ ...board(), stages: { ...stages(), "07": { meaning: "x" } } })),
    ).toEqual(["stages: unknown key '07'"]);
  });

  it("says to quote a stage id written as a bare number, with where it is", () => {
    const quoted = stringify(board());
    expect(quoted).toContain('  "01":');
    const text = quoted.replace('  "01":', "  01:");
    const line = text.split("\n").indexOf("  01:") + 1;
    expect(errorsOf(parseBoardDeclaration(text, { manifestRepoPaths: REPOS }))).toEqual([
      `not valid YAML: the key 01 at line ${line}, column 3 is not a string; write it in quotes`,
    ]);
  });

  it("refuses an empty title, lane name, unit or stage meaning", () => {
    const doc = board();
    doc.title = "  ";
    entry(doc.lanes, 1).name = "";
    entry(doc.stages, "01").meaning = "";
    entry(doc.measures, 0).unit = "";
    expect(errorsOf(parse(doc))).toEqual([
      "title: must be a non-empty string",
      "stages.01.meaning: must be a non-empty string",
      "lanes[1].name: must be a non-empty string",
      "measures[0].unit: must be a non-empty string",
    ]);
  });

  it("refuses a board with no lanes", () => {
    expect(
      errorsOf(parse({ ...board(), lanes: [], components: {}, measures: [], ratios: [] })),
    ).toEqual(["lanes: must list at least one lane"]);
  });

  it("refuses an id that is not lowercase ASCII", () => {
    const doc = board();
    entry(doc.lanes, 0).id = "Saddle";
    entry(doc.measures, 0).id = "cli commands";
    const errors = errorsOf(parse(doc));
    expect(errors).toContain(
      "lanes[0].id: must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
    );
    expect(errors).toContain(
      "measures[0].id: must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
    );
  });

  it("refuses an unknown kind and a kind's missing keys", () => {
    expect(errorsOf(parse(withMeasure({ id: "a", kind: "shell", repo: ".", unit: "x" })))).toEqual([
      "measures[0].kind: Invalid discriminator value. Expected 'file_count' | 'dir_count' | 'line_count' | 'match_count' | 'regex_capture' | 'json_length' | 'trail_count'",
    ]);
    expect(errorsOf(parse(withMeasure({ id: "a", kind: "file_count", repo: "." })))).toEqual([
      "measures[0].unit: Invalid input: expected string, received undefined",
      "measures[0].include: Invalid input: expected array, received undefined",
    ]);
    expect(
      errorsOf(
        parse(withMeasure({ id: "a", kind: "dir_count", repo: ".", path: "src", unit: "dirs" })),
      ),
    ).toEqual(["measures[0].depth: Invalid input: expected number, received undefined"]);
  });

  it("names what a kind takes in the version the file is read by", () => {
    // Version 2: an observation takes no notes yet, and file_name is no kind.
    const v2 = boardV2();
    v2.observe = [{ key: "a", kind: "manual", how: "ask", colour: "red" }];
    expect(errorsOf(parse(v2))).toEqual([
      "observe[0]: unknown key 'colour' (kind 'manual' takes: key, kind, how)",
    ]);
    // Version 3: the same kind takes notes.
    const v3 = boardV2();
    v3.board_version = 3;
    v3.observe = [{ key: "a", kind: "manual", how: "ask", colour: "red" }];
    expect(errorsOf(parse(v3))).toEqual([
      "observe[0]: unknown key 'colour' (kind 'manual' takes: key, kind, how, notes)",
    ]);
    // Not for a key outside a measure or an observation.
    const lane = boardV2();
    entry(lane.lanes, 0).colour = "red";
    expect(errorsOf(parse(lane))).toEqual(["lanes[0]: unknown key 'colour'"]);
  });

  it("names the keys of the newest shape for a file with no version, or one that is not a number", () => {
    for (const version of [undefined, "2"]) {
      const doc = boardV2();
      if (version === undefined) delete doc.board_version;
      else doc.board_version = version;
      doc.observe = [{ key: "a", kind: "manual", how: "ask", colour: "red" }];
      expect(errorsOf(parse(doc)), String(version)).toContain(
        "observe[0]: unknown key 'colour' (kind 'manual' takes: key, kind, how, notes)",
      );
    }
  });

  it("names no keys for a key called kind outside a measure or an observation", () => {
    const doc = boardV2();
    entry(entry(doc.measures, 1), "section").kind = "file_count";
    entry(doc.lanes, 0).kind = "file_count";
    expect(errorsOf(parse(doc))).toEqual([
      "lanes[0]: unknown key 'kind'",
      "measures[1].section: unknown key 'kind'",
    ]);
  });

  it("refuses keys that belong to another kind", () => {
    expect(
      errorsOf(
        parse(withMeasure({ id: "a", kind: "trail_count", of: "tasks", repo: ".", unit: "tasks" })),
      ),
    ).toEqual([
      "measures[0]: unknown key 'repo' (kind 'trail_count' takes: kind, id, unit, lane, of, status)",
    ]);
    expect(
      errorsOf(
        parse(
          withMeasure({
            id: "a",
            kind: "file_count",
            repo: ".",
            include: ["a"],
            pattern: "x",
            unit: "files",
          }),
        ),
      ),
    ).toEqual([
      "measures[0]: unknown key 'pattern' (kind 'file_count' takes: kind, id, unit, lane, repo, at, include, exclude)",
    ]);
  });

  it.each(["src/*", "src/[ab]", "s?c", "a\\b"])(
    "refuses a dir_count path with a wildcard: %j",
    (path) => {
      expect(
        errorsOf(
          parse(
            withMeasure({ id: "a", kind: "dir_count", repo: ".", path, depth: 1, unit: "dirs" }),
          ),
        ),
      ).toEqual(["measures[0].path: must be a directory path, without '*', '?', '[' or '\\'"]);
    },
  );

  it("refuses a dir_count depth below 1 and an empty include list", () => {
    expect(
      errorsOf(
        parse(
          withMeasure({
            id: "a",
            kind: "dir_count",
            repo: ".",
            path: "src",
            depth: 0,
            unit: "dirs",
          }),
        ),
      ),
    ).toEqual(["measures[0].depth: Too small: expected number to be >=1"]);
    expect(
      errorsOf(
        parse(withMeasure({ id: "a", kind: "file_count", repo: ".", include: [], unit: "files" })),
      ),
    ).toEqual(["measures[0].include: must list at least one path"]);
  });
});

describe("parseBoardDeclaration: paths stay inside the repository", () => {
  it.each([
    ["/etc/passwd", "must be relative to the repository"],
    ["\\\\server\\share", "must be relative to the repository"],
    ["C:/Windows", "must be relative to the repository (a leading 'x:' reads as a Windows drive)"],
    ["x:y.md", "must be relative to the repository (a leading 'x:' reads as a Windows drive)"],
    ["../other/file", "must not contain a '..' segment"],
    ["docs/../../x", "must not contain a '..' segment"],
    ["docs\\..\\x", "must not contain a '..' segment"],
    [":(top)*.md", "must not start with ':' (pathspec magic)"],
    ["", "must be a non-empty path"],
    ["a\u0007b", "must not contain control characters"],
  ])("refuses %j in include, exclude, file and path", (bad, message) => {
    const doc = {
      ...board(),
      measures: [
        { id: "a", kind: "file_count", repo: ".", include: [bad], exclude: [bad], unit: "files" },
        { id: "b", kind: "json_length", repo: ".", file: bad, pointer: "", unit: "items" },
        { id: "c", kind: "dir_count", repo: ".", path: bad, depth: 1, unit: "dirs" },
      ],
      ratios: [],
    };
    expect(errorsOf(parse(doc))).toEqual([
      `measures[0].include[0]: ${message}`,
      `measures[0].exclude[0]: ${message}`,
      `measures[1].file: ${message}`,
      `measures[2].path: ${message}`,
    ]);
  });

  it("accepts '..' as part of a name and '.' as a directory", () => {
    const result = parse(
      withMeasure({
        id: "a",
        kind: "file_count",
        repo: ".",
        include: ["a..b/*.md", "./docs/*.md"],
        unit: "files",
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("parseBoardDeclaration: patterns, revisions and pointers", () => {
  it("compiles patterns with the u flag", () => {
    const errors = errorsOf(
      parse(
        withMeasure({
          id: "a",
          kind: "match_count",
          repo: ".",
          include: ["a"],
          pattern: "a\\-b",
          unit: "x",
        }),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^measures\[0\]\.pattern: is not a valid regular expression with the 'u' flag \(/,
    );
  });

  it("refuses an empty or broken pattern, start or end", () => {
    const errors = errorsOf(
      parse(
        withMeasure({
          id: "a",
          kind: "match_count",
          repo: ".",
          include: ["a"],
          pattern: "",
          section: { start: "(", end: "[", on_missing: "zero" },
          unit: "x",
        }),
      ),
    );
    expect(errors[0]).toBe("measures[0].pattern: must be a non-empty regular expression");
    expect(errors[1]).toMatch(/^measures\[0\]\.section\.start: is not a valid regular expression/);
    expect(errors[2]).toMatch(/^measures\[0\]\.section\.end: is not a valid regular expression/);
    expect(errors).toHaveLength(3);
  });

  it.each(["-o", "--output=x", "main:docs", "two words", "", "a\tb"])(
    "refuses the revision %j",
    (at) => {
      expect(
        errorsOf(
          parse(
            withMeasure({ id: "a", kind: "file_count", repo: ".", include: ["a"], at, unit: "x" }),
          ),
        ),
      ).toEqual([
        "measures[0].at: must be 'worktree' or a git revision with no leading '-', whitespace or ':'",
      ]);
    },
  );

  it.each(["main", "origin/main", "HEAD~1", "v0.64.0", "worktree"])(
    "accepts the revision %j",
    (at) => {
      expect(
        parse(
          withMeasure({ id: "a", kind: "file_count", repo: ".", include: ["a"], at, unit: "x" }),
        ).ok,
      ).toBe(true);
    },
  );

  it.each(["files", "/a~2b", "/a~"])("refuses the JSON pointer %j", (pointer) => {
    expect(
      errorsOf(
        parse(
          withMeasure({
            id: "a",
            kind: "json_length",
            repo: ".",
            file: "a.json",
            pointer,
            unit: "x",
          }),
        ),
      ),
    ).toEqual([
      "measures[0].pointer: must be a JSON pointer (RFC 6901): empty, or '/' tokens with '~' only as '~0' or '~1'",
    ]);
  });

  it.each(["", "/", "/a~0b/~1c/0"])("accepts the JSON pointer %j", (pointer) => {
    expect(
      parse(
        withMeasure({
          id: "a",
          kind: "json_length",
          repo: ".",
          file: "a.json",
          pointer,
          unit: "x",
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("parseBoardDeclaration: sections", () => {
  it("requires on_missing, as zero or null, on a match_count", () => {
    const section = (s: Record<string, unknown>) =>
      withMeasure({
        id: "a",
        kind: "match_count",
        repo: ".",
        include: ["a"],
        pattern: "x",
        section: s,
        unit: "x",
      });
    expect(errorsOf(parse(section({ start: "^## A" })))).toEqual([
      "measures[0].section.on_missing: must be zero or null",
    ]);
    expect(errorsOf(parse(section({ start: "^## A", on_missing: "skip" })))).toEqual([
      "measures[0].section.on_missing: must be zero or null",
    ]);
    expect(parse(section({ start: "^## A", on_missing: null })).ok).toBe(true);
  });

  it("allows only null on a regex_capture, whose value is a string", () => {
    const section = (s: Record<string, unknown>) =>
      withMeasure({
        id: "a",
        kind: "regex_capture",
        repo: ".",
        file: "a",
        pattern: "(x)",
        section: s,
        unit: "x",
      });
    expect(errorsOf(parse(section({ start: "^## A", on_missing: "zero" })))).toEqual([
      "measures[0].section.on_missing: must be null for regex_capture (a string has no zero)",
    ]);
    expect(errorsOf(parse(section({ start: "^## A" })))).toEqual([
      "measures[0].section.on_missing: must be null for regex_capture (a string has no zero)",
    ]);
    expect(parse(section({ start: "^## A", on_missing: null })).ok).toBe(true);
  });
});

describe("parseBoardDeclaration: what one key says about another", () => {
  it("refuses duplicate lane, measure and ratio ids", () => {
    const doc = board();
    (doc.lanes as Record<string, unknown>[]).push({ id: "saddle", name: "Again" });
    (doc.measures as Record<string, unknown>[]).push({
      id: "src_lines",
      kind: "trail_count",
      of: "tasks",
      unit: "x",
    });
    (doc.ratios as Record<string, unknown>[]).push({
      id: "test_to_src",
      label: "x",
      numerator: "src_lines",
      denominator: "src_lines",
    });
    expect(errorsOf(parse(doc))).toEqual([
      "lanes[2].id: duplicate lane id 'saddle' (first at lanes[0])",
      "measures[4].id: duplicate measure id 'src_lines' (first at measures[2])",
      "ratios[1].id: duplicate ratio id 'test_to_src' (first at ratios[0])",
    ]);
  });

  it("refuses a repo the manifest does not declare, matched as written", () => {
    expect(
      errorsOf(
        parse(
          withMeasure({ id: "a", kind: "file_count", repo: "basou", include: ["a"], unit: "x" }),
        ),
      ),
    ).toEqual([
      "measures[0].repo: 'basou' is not a repo path in the manifest (the manifest declares '.', '../basou')",
    ]);
    expect(
      errorsOf(
        parse(
          withMeasure({ id: "a", kind: "file_count", repo: ".", include: ["a"], unit: "x" }),
          [],
        ),
      ),
    ).toEqual([
      "measures[0].repo: '.' is not a repo path in the manifest (the manifest declares no repos)",
    ]);
  });

  it("refuses a measure lane that does not exist", () => {
    expect(
      errorsOf(
        parse(
          withMeasure({ id: "a", kind: "trail_count", of: "tasks", lane: "nowhere", unit: "x" }),
        ),
      ),
    ).toEqual(["measures[0].lane: no lane has the id 'nowhere'"]);
  });

  it("refuses a capture group the pattern does not have", () => {
    const capture = (pattern: string, group?: number) =>
      withMeasure({
        id: "a",
        kind: "regex_capture",
        repo: ".",
        file: "a",
        pattern,
        unit: "x",
        ...(group === undefined ? {} : { group }),
      });
    expect(errorsOf(parse(capture("^## [0-9]+")))).toEqual([
      "measures[0].group: the pattern has 0 capturing groups, so group 1 does not exist",
    ]);
    expect(errorsOf(parse(capture("^## ([0-9]+)", 2)))).toEqual([
      "measures[0].group: the pattern has 1 capturing group, so group 2 does not exist",
    ]);
    expect(parse(capture("^## (?:x)([0-9]+)(?<rest>.*)", 2)).ok).toBe(true);
  });

  it("refuses a trail_count of something it does not count", () => {
    const errors = errorsOf(
      parse(withMeasure({ id: "a", kind: "trail_count", of: "commits", unit: "x" })),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^measures\[0\]\.of: /);
  });

  it("allows a status only on a trail_count of tasks, and only a task status", () => {
    expect(
      errorsOf(
        parse(
          withMeasure({
            id: "a",
            kind: "trail_count",
            of: "tracks_open",
            status: "done",
            unit: "x",
          }),
        ),
      ),
    ).toEqual(["measures[0].status: only a trail_count of 'tasks' takes a status"]);
    const unknown = errorsOf(
      parse(
        withMeasure({ id: "a", kind: "trail_count", of: "tasks", status: "blocked", unit: "x" }),
      ),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatch(/^measures\[0\]\.status: /);
  });

  it("refuses a ratio over a measure that does not exist or is not a number", () => {
    const doc = board();
    (doc.measures as Record<string, unknown>[]).push({
      id: "latest",
      kind: "regex_capture",
      repo: "../basou",
      file: "CHANGELOG.md",
      pattern: "^## (.*)",
      unit: "version",
    });
    doc.ratios = [{ id: "r", label: "r", numerator: "nothing", denominator: "latest" }];
    expect(errorsOf(parse(doc))).toEqual([
      "ratios[0].numerator: no measure has the id 'nothing'",
      "ratios[0].denominator: 'latest' is a regex_capture, which is not a number",
    ]);
  });

  it("checks each component's lanes and requires a note on '-'", () => {
    const doc = board();
    doc.components = {
      "basou/packages/sdk": { lane: ["saddle", "saddle", "nowhere"] },
      basou: { lane: "-" },
      "basou/packages/cli": { lane: "saddle" },
      "basou/apps": { lane: [] },
    };
    expect(errorsOf(parse(doc))).toEqual([
      "components[\"basou/packages/cli\"].lane: must be '-' or a non-empty list of lane ids",
      "components[\"basou/apps\"].lane: must list at least one lane id, or be '-'",
      "components[\"basou/packages/sdk\"].lane[1]: 'saddle' is listed twice",
      "components[\"basou/packages/sdk\"].lane[2]: no lane has the id 'nowhere'",
      "components.basou.note: a component with lane '-' needs a note saying why",
    ]);
  });
});

describe("parseBoardDeclaration: axis and effort", () => {
  it("refuses a date that is not a calendar date, a bad time zone and a milestone without a ref", () => {
    const doc = board();
    doc.axis = { version: 0, review_due_days: 60, seed_review: { date: "2026-02-30", model: "m" } };
    doc.effort = {
      start: "2026/04/28",
      time_zone: "Mars/Olympus",
      milestones: [{ date: "2026-10-04", label: "v0.64.0" }],
    };
    expect(errorsOf(parse(doc))).toEqual([
      "axis.version: Too small: expected number to be >=1",
      "axis.seed_review.date: must be a calendar date written as YYYY-MM-DD",
      "effort.start: must be a calendar date written as YYYY-MM-DD",
      "effort.time_zone: must be a time zone name such as Asia/Tokyo, not an offset such as +09:00",
      "effort.milestones[0].ref: Invalid input: expected string, received undefined",
    ]);
  });

  it("reads an unquoted date as the string it is written as", () => {
    const text = stringify(board());
    expect(text).toContain("start: 2026-04-28\n");
    const result = parseBoardDeclaration(text, { manifestRepoPaths: REPOS });
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.effort.start).toBe("2026-04-28");
  });
});

describe("parseBoardDeclaration: the YAML itself", () => {
  it("refuses a duplicate key", () => {
    const text = `${stringify(board())}title: Again\n`;
    const errors = errorsOf(parseBoardDeclaration(text, { manifestRepoPaths: REPOS }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^not valid YAML: Map keys must be unique/);
  });

  it("refuses a tag it cannot resolve, which YAML reports only as a warning", () => {
    const plain = stringify(board());
    expect(plain).toContain("title: A board\n");
    const text = plain.replace("title: A board\n", "title: !custom A board\n");
    const errors = errorsOf(parseBoardDeclaration(text, { manifestRepoPaths: REPOS }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^not valid YAML: .*!custom/);
  });

  it("refuses text that is not YAML", () => {
    const errors = errorsOf(
      parseBoardDeclaration("title: [unclosed\n", { manifestRepoPaths: REPOS }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.startsWith("not valid YAML: "))).toBe(true);
  });

  it.each(["", "- a list\n", "just text\n"])("refuses %j, which is not a mapping", (text) => {
    expect(errorsOf(parseBoardDeclaration(text, { manifestRepoPaths: REPOS }))).toEqual([
      "(top level): must be a mapping of keys to values",
    ]);
  });
});

describe("parseBoardDeclaration: reporting", () => {
  it("reports every problem at once: shapes and cross-references together", () => {
    const doc = board();
    doc.extra = true;
    entry(doc.lanes, 1).id = "saddle";
    entry(doc.measures, 0).repo = "../elsewhere";
    entry(doc.measures, 2).include = ["../x"];
    doc.ratios = [{ id: "r", label: "r", numerator: "missing", denominator: "src_lines" }];
    expect(errorsOf(parse(doc))).toEqual([
      "measures[2].include[0]: must not contain a '..' segment",
      "(top level): unknown key 'extra'",
      "lanes[1].id: duplicate lane id 'saddle' (first at lanes[0])",
      "measures[0].repo: '../elsewhere' is not a repo path in the manifest (the manifest declares '.', '../basou')",
      // Renaming the second lane removed 'cockpit', which two references still name.
      "measures[0].lane: no lane has the id 'cockpit'",
      "ratios[0].numerator: no measure has the id 'missing'",
      "components[\"basou/packages/sdk\"].lane[1]: no lane has the id 'cockpit'",
    ]);
  });
});

describe("parseBoardDeclaration: strictness and required keys at every level", () => {
  const extra = (target: Record<string, unknown>) => {
    target.extra = 1;
  };
  const fileKeys = "kind, id, unit, lane, repo, at, include, exclude";
  it.each<[string, (doc: Record<string, unknown>) => void, string, string?]>([
    [
      "a file_count",
      (d) => extra(entry(d.measures, 0)),
      "measures[0]",
      ` (kind 'file_count' takes: ${fileKeys})`,
    ],
    [
      "a line_count",
      (d) => extra(entry(d.measures, 2)),
      "measures[2]",
      ` (kind 'line_count' takes: ${fileKeys})`,
    ],
    [
      "a match_count",
      (d) => extra(entry(d.measures, 1)),
      "measures[1]",
      ` (kind 'match_count' takes: ${fileKeys}, pattern, section)`,
    ],
    [
      "a match_count section",
      (d) => extra(entry(entry(d.measures, 1), "section")),
      "measures[1].section",
    ],
    ["a ratio", (d) => extra(entry(d.ratios, 0)), "ratios[0]"],
    ["a component", (d) => extra(entry(d.components, "basou")), "components.basou"],
    ["seed_review", (d) => extra(entry(d.axis, "seed_review")), "axis.seed_review"],
    ["effort", (d) => extra(entry(d, "effort")), "effort"],
    ["a milestone", (d) => extra(entry(entry(d.effort, "milestones"), 0)), "effort.milestones[0]"],
  ])("refuses an unknown key in %s", (_what, change, at, takes = "") => {
    const doc = board();
    change(doc);
    expect(errorsOf(parse(doc))).toEqual([`${at}: unknown key 'extra'${takes}`]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["dir_count", { id: "a", kind: "dir_count", repo: ".", path: "src", depth: 1, unit: "x" }],
    [
      "regex_capture",
      { id: "a", kind: "regex_capture", repo: ".", file: "a", pattern: "(x)", unit: "x" },
    ],
    [
      "a regex_capture section",
      {
        id: "a",
        kind: "regex_capture",
        repo: ".",
        file: "a",
        pattern: "(x)",
        section: { start: "^#", on_missing: null },
        unit: "x",
      },
    ],
    [
      "json_length",
      { id: "a", kind: "json_length", repo: ".", file: "a.json", pointer: "", unit: "x" },
    ],
    ["trail_count", { id: "a", kind: "trail_count", of: "tasks", unit: "x" }],
  ])("refuses an unknown key in %s", (what, measure) => {
    const target = what.endsWith("section")
      ? (measure.section as Record<string, unknown>)
      : measure;
    target.extra = 1;
    const at = what.endsWith("section") ? "measures[0].section" : "measures[0]";
    // A measure's problem names what its kind takes; a section's does not.
    const kindKeys: Record<string, string> = {
      dir_count: "kind, id, unit, lane, repo, at, path, depth, include, exclude",
      regex_capture: "kind, id, unit, lane, repo, at, file, pattern, group, section",
      json_length: "kind, id, unit, lane, repo, at, file, pointer",
      trail_count: "kind, id, unit, lane, of, status",
    };
    const takes = what.endsWith("section") ? "" : ` (kind '${what}' takes: ${kindKeys[what]})`;
    expect(errorsOf(parse(withMeasure(measure)))).toEqual([`${at}: unknown key 'extra'${takes}`]);
  });

  it.each<[string, string, (doc: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["axis", "version", (d) => entry(d, "axis"), "number"],
    ["axis", "review_due_days", (d) => entry(d, "axis"), "number"],
    ["axis.seed_review", "date", (d) => entry(d.axis, "seed_review"), "string"],
    ["axis.seed_review", "model", (d) => entry(d.axis, "seed_review"), "string"],
    ["effort", "start", (d) => entry(d, "effort"), "string"],
    ["effort.milestones[0]", "date", (d) => entry(entry(d.effort, "milestones"), 0), "string"],
    ["effort.milestones[0]", "label", (d) => entry(entry(d.effort, "milestones"), 0), "string"],
    ["lanes[1]", "name", (d) => entry(d.lanes, 1), "string"],
    ["stages.04", "meaning", (d) => entry(d.stages, "04"), "string"],
    ["measures[0]", "id", (d) => entry(d.measures, 0), "string"],
    ["ratios[0]", "id", (d) => entry(d.ratios, 0), "string"],
    ["ratios[0]", "label", (d) => entry(d.ratios, 0), "string"],
    ["ratios[0]", "numerator", (d) => entry(d.ratios, 0), "string"],
    ["ratios[0]", "denominator", (d) => entry(d.ratios, 0), "string"],
  ])("requires %s.%s", (at, key, target, type) => {
    const doc = board();
    delete target(doc)[key];
    expect(errorsOf(parse(doc))).toEqual([
      `${at}.${key}: Invalid input: expected ${type}, received undefined`,
    ]);
  });

  it("requires a lane's id", () => {
    const doc = board();
    (doc.lanes as unknown[]).push({ name: "Spare" });
    expect(errorsOf(parse(doc))).toEqual([
      "lanes[2].id: Invalid input: expected string, received undefined",
    ]);
  });

  it("requires a component's lane", () => {
    const doc = board();
    delete entry(doc.components, "basou").lane;
    expect(errorsOf(parse(doc))).toEqual([
      "components.basou.lane: must be '-' or a non-empty list of lane ids",
    ]);
  });

  it("accepts a board with every optional key left out", () => {
    const doc = board();
    doc.lanes = [{ id: "saddle", name: "Saddle" }];
    doc.measures = [{ id: "a", kind: "file_count", repo: ".", include: ["a"], unit: "files" }];
    doc.ratios = [];
    doc.components = { basou: { lane: ["saddle"] } };
    doc.axis = { version: 1, review_due_days: 60 };
    doc.effort = { start: "2026-04-28" };
    expect(parse(doc).ok).toBe(true);
  });

  it.each<[string, (doc: Record<string, unknown>) => void, string]>([
    [
      "a dir_count depth",
      (d) => {
        d.measures = [
          { id: "a", kind: "dir_count", repo: ".", path: "src", depth: 1.5, unit: "x" },
        ];
        d.ratios = [];
      },
      "measures[0].depth: Invalid input: expected int, received number",
    ],
    [
      "a regex_capture group",
      (d) => {
        d.measures = [
          {
            id: "a",
            kind: "regex_capture",
            repo: ".",
            file: "a",
            pattern: "(x)",
            group: 1.5,
            unit: "x",
          },
        ];
        d.ratios = [];
      },
      "measures[0].group: Invalid input: expected int, received number",
    ],
    [
      "a negative group",
      (d) => {
        d.measures = [
          {
            id: "a",
            kind: "regex_capture",
            repo: ".",
            file: "a",
            pattern: "(x)",
            group: -1,
            unit: "x",
          },
        ];
        d.ratios = [];
      },
      "measures[0].group: Too small: expected number to be >=0",
    ],
    [
      "axis.version",
      (d) => {
        entry(d, "axis").version = 1.5;
      },
      "axis.version: Invalid input: expected int, received number",
    ],
    [
      "axis.review_due_days",
      (d) => {
        entry(d, "axis").review_due_days = 0;
      },
      "axis.review_due_days: Too small: expected number to be >=1",
    ],
    [
      "a ratio id",
      (d) => {
        entry(d.ratios, 0).id = "Ratio";
      },
      "ratios[0].id: must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
    ],
    [
      "a lane note",
      (d) => {
        entry(d.lanes, 0).notes = [""];
      },
      "lanes[0].notes[0]: must be a non-empty string",
    ],
    [
      "a lane about",
      (d) => {
        entry(d.lanes, 0).about = " ";
      },
      "lanes[0].about: must be a non-empty string",
    ],
    [
      "a milestone label",
      (d) => {
        entry(entry(d.effort, "milestones"), 0).label = "";
      },
      "effort.milestones[0].label: must be a non-empty string",
    ],
    [
      "a milestone date",
      (d) => {
        entry(entry(d.effort, "milestones"), 0).date = "soon";
      },
      "effort.milestones[0].date: must be a calendar date written as YYYY-MM-DD",
    ],
    [
      "a component note",
      (d) => {
        entry(d.components, "basou").note = "";
      },
      "components.basou.note: must be a non-empty string",
    ],
  ])("checks the form of %s", (_what, change, error) => {
    const doc = board();
    change(doc);
    expect(errorsOf(parse(doc))).toEqual([error]);
  });

  it("takes a ratio over every kind of measure that counts", () => {
    const measures = [
      { id: "a", kind: "file_count", repo: ".", include: ["a"], unit: "x" },
      { id: "b", kind: "dir_count", repo: ".", path: "src", depth: 1, unit: "x" },
      { id: "c", kind: "line_count", repo: ".", include: ["a"], unit: "x" },
      { id: "d", kind: "match_count", repo: ".", include: ["a"], pattern: "x", unit: "x" },
      { id: "e", kind: "json_length", repo: ".", file: "a.json", pointer: "", unit: "x" },
      { id: "f", kind: "trail_count", of: "tasks", unit: "x" },
    ];
    const ratios = measures.map((m) => ({
      id: `r_${m.id}`,
      label: "r",
      numerator: m.id,
      denominator: "a",
    }));
    expect(parse({ ...board(), measures, ratios }).ok).toBe(true);
  });

  it("refuses an entry that is null, without throwing", () => {
    const doc = board();
    doc.lanes = [null, { id: "saddle", name: "Saddle" }, { id: "cockpit", name: "Cockpit" }];
    doc.measures = [null];
    doc.ratios = [null];
    doc.components = { x: null };
    entry(doc, "effort").milestones = [null];
    const errors = errorsOf(parse(doc));
    for (const at of [
      "lanes[0]",
      "measures[0]",
      "ratios[0]",
      "components.x",
      "effort.milestones[0]",
    ]) {
      expect(errors.some((e) => e.startsWith(`${at}: `))).toBe(true);
    }
  });

  it("refuses a document that expands aliases without limit, without throwing", () => {
    const levels = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 9; i++) {
      const prev = String.fromCharCode(96 + i);
      const name = String.fromCharCode(97 + i);
      levels.push(`${name}: &${name} [${Array(10).fill(`*${prev}`).join(", ")}]`);
    }
    const errors = errorsOf(
      parseBoardDeclaration(`${levels.join("\n")}\n`, { manifestRepoPaths: REPOS }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^not valid YAML: /);
  });
});

describe("parseBoardDeclaration: what the review found", () => {
  it("refuses a component named __proto__, which the shape check would skip", () => {
    const text = stringify(board()).replace(
      "components:\n",
      "components:\n  __proto__:\n    lane: [saddle]\n    junk: 1\n",
    );
    expect(errorsOf(parseBoardDeclaration(text, { manifestRepoPaths: REPOS }))).toEqual([
      "components.__proto__: a component cannot be named __proto__",
    ]);
    expect(({} as Record<string, unknown>).lane).toBeUndefined();
  });

  it("refuses an empty component key", () => {
    const doc = board();
    doc.components = { "": { lane: ["saddle"] }, "  ": { lane: ["saddle"] } };
    expect(errorsOf(parse(doc))).toEqual([
      'components[""]: a component key must be a non-empty path',
      'components["  "]: a component key must be a non-empty path',
    ]);
  });

  it("does not look up lane references when lanes is not a list", () => {
    const doc = board();
    doc.lanes = { saddle: { name: "Saddle" }, cockpit: { name: "Cockpit" } };
    // measures[0] and a component still name 'cockpit' and 'saddle'.
    expect(errorsOf(parse(doc))).toEqual(["lanes: Invalid input: expected array, received object"]);
  });

  it("does not look up references in a list that is not a list", () => {
    const doc = board();
    doc.lanes = { saddle: { name: "Saddle" } };
    doc.measures = { a: { kind: "file_count" } };
    const errors = errorsOf(parse(doc));
    expect(errors).toEqual([
      "lanes: Invalid input: expected array, received object",
      "measures: Invalid input: expected array, received object",
    ]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "a repo on a kind that takes none",
      { id: "a", kind: "trail_count", of: "tasks", repo: "nope", unit: "x" },
      "measures[0]: unknown key 'repo'",
    ],
    [
      "a status when of is not a known count",
      { id: "a", kind: "trail_count", of: "commits", status: "done", unit: "x" },
      "measures[0].of: ",
    ],
    [
      "a group over an empty pattern",
      { id: "a", kind: "regex_capture", repo: ".", file: "a", pattern: "", unit: "x" },
      "measures[0].pattern: must be a non-empty regular expression",
    ],
    [
      "an empty repo",
      { id: "a", kind: "file_count", repo: "", include: ["a"], unit: "x" },
      "measures[0].repo: must be a non-empty string",
    ],
    [
      "a lane that is not an id",
      { id: "a", kind: "trail_count", of: "tasks", lane: "Saddle", unit: "x" },
      "measures[0].lane: must start with a lowercase letter",
    ],
    [
      "a group that is not an integer",
      { id: "a", kind: "regex_capture", repo: ".", file: "a", pattern: "x", group: 1.5, unit: "x" },
      "measures[0].group: Invalid input: expected int",
    ],
  ])("reports %s once", (_what, measure, start) => {
    const errors = errorsOf(parse(withMeasure(measure)));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.startsWith(start)).toBe(true);
  });

  it("reports a ratio or component reference that is not an id once", () => {
    const doc = board();
    entry(doc.ratios, 0).numerator = "Bad";
    doc.components = { "x/y": { lane: ["Bad", "-"] } };
    expect(errorsOf(parse(doc))).toEqual([
      "ratios[0].numerator: must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
      "components[\"x/y\"].lane[0]: must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
      "components[\"x/y\"].lane[1]: must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
    ]);
  });

  it("refuses a %YAML directive for another version and accepts one for 1.2", () => {
    const text = stringify(board());
    expect(
      errorsOf(parseBoardDeclaration(`%YAML 1.1\n---\n${text}`, { manifestRepoPaths: REPOS })),
    ).toEqual(["not valid YAML: a board is read as YAML 1.2; remove the %YAML 1.1 directive"]);
    expect(parseBoardDeclaration(`%YAML 1.2\n---\n${text}`, { manifestRepoPaths: REPOS }).ok).toBe(
      true,
    );
  });

  it("names an unknown board_version before a YAML warning", () => {
    const plain = stringify({ ...board(), board_version: 4 });
    expect(plain).toContain("title: A board\n");
    const text = plain.replace("title: A board\n", "title: !v4tag A board\n");
    expect(errorsOf(parseBoardDeclaration(text, { manifestRepoPaths: REPOS }))).toEqual([
      "board_version: this basou reads board_version 1, 2 or 3, not 4",
    ]);
  });

  it("gives a YAML error's line and column without a dangling colon", () => {
    const errors = errorsOf(
      parseBoardDeclaration(`${stringify(board())}title: Again\n`, { manifestRepoPaths: REPOS }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^not valid YAML: Map keys must be unique at line \d+, column \d+$/);
  });

  it.each(["0050-06-15", "0000-01-01", "2024-02-29"])("accepts the date %j", (date) => {
    const doc = board();
    entry(doc, "effort").start = date;
    expect(parse(doc).ok).toBe(true);
  });

  it.each(["0050-02-30", "2025-02-29", "2026-13-01"])("refuses the date %j", (date) => {
    const doc = board();
    entry(doc, "effort").start = date;
    expect(errorsOf(parse(doc))).toEqual([
      "effort.start: must be a calendar date written as YYYY-MM-DD",
    ]);
  });

  it.each(["+09:00", "-0500", "+9"])("refuses the offset %j as a time zone", (zone) => {
    const doc = board();
    entry(doc, "effort").time_zone = zone;
    expect(errorsOf(parse(doc))).toEqual([
      "effort.time_zone: must be a time zone name such as Asia/Tokyo, not an offset such as +09:00",
    ]);
  });

  it.each(["UTC", "Etc/GMT-9", "America/New_York"])("accepts the time zone %j", (zone) => {
    const doc = board();
    entry(doc, "effort").time_zone = zone;
    expect(parse(doc).ok).toBe(true);
  });

  it("refuses a C1 control character in a path and a revision", () => {
    const measure = {
      id: "a",
      kind: "file_count",
      repo: ".",
      include: ["a\u0085b"],
      at: "ma\u0085in",
      unit: "x",
    };
    expect(errorsOf(parse(withMeasure(measure)))).toEqual([
      "measures[0].at: must be 'worktree' or a git revision with no leading '-', whitespace or ':'",
      "measures[0].include[0]: must not contain control characters",
    ]);
  });

  it.each<[string, string]>([
    ["  1.50:\n    lane: '-'\n    note: x\n", "not valid YAML: the key 1.50 at line"],
    ["  0x10:\n    lane: '-'\n    note: x\n", "not valid YAML: the key 0x10 at line"],
    ["  ~:\n    lane: '-'\n    note: x\n", "not valid YAML: the key ~ at line"],
    ["  ? [a, b]\n  : { lane: '-', note: x }\n", "not valid YAML: the key at line"],
  ])("refuses the key in %j instead of renaming it, and prints nothing", (lines, start) => {
    const warn = vi.spyOn(process, "emitWarning");
    try {
      const text = stringify(board()).replace("components:\n", `components:\n${lines}`);
      const errors = errorsOf(parseBoardDeclaration(text, { manifestRepoPaths: REPOS }));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.startsWith(start)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// A board of version 2, observing one thing of each kind.
function boardV2(): Record<string, unknown> {
  const doc = board();
  entry(doc.stages, "05").look = ["the published version on npm"];
  entry(doc.stages, "05").notes = ["on main but not published is part"];
  return {
    ...doc,
    board_version: 2,
    observe: [
      { key: "npm_cli", kind: "npm_version", package: "@scope/cli" },
      { key: "github_release", kind: "github_release", repo: "owner/name" },
      { key: "github_open_issues", kind: "github_open_issues", repo: "owner/name" },
      { key: "github_open_prs", kind: "github_open_prs", repo: "owner/name.js" },
      { key: "github_main_ci", kind: "github_ci", repo: "owner/name", workflow: "quality.yml" },
      { key: "site_en", kind: "page_version", url: "https://example.com/" },
      { key: "db_users", kind: "manual", how: "count the users in production, read only" },
    ],
  };
}

// A version 2 board whose only observation is `observe`.
function withObserve(observe: Record<string, unknown>): Record<string, unknown> {
  return { ...boardV2(), observe: [observe] };
}

describe("parseBoardDeclaration: board_version 2", () => {
  it("accepts what to observe and what to look at for each stage, filling the default branch", () => {
    const result = parse(boardV2());
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const { declaration } = result;
    expect(declaration.board_version).toBe(2);
    expect(declaration.observe.map((o) => [o.key, o.kind])).toEqual([
      ["npm_cli", "npm_version"],
      ["github_release", "github_release"],
      ["github_open_issues", "github_open_issues"],
      ["github_open_prs", "github_open_prs"],
      ["github_main_ci", "github_ci"],
      ["site_en", "page_version"],
      ["db_users", "manual"],
    ]);
    expect(declaration.observe[4]).toEqual({
      key: "github_main_ci",
      kind: "github_ci",
      repo: "owner/name",
      workflow: "quality.yml",
      branch: "main",
    });
    expect(declaration.stages["05"]).toEqual({
      meaning: "stage 05",
      look: ["the published version on npm"],
      notes: ["on main but not published is part"],
    });
    expect(declaration.stages["01"]).toEqual({ meaning: "stage 01" });
  });

  it("reads a version 2 board without observe as observing nothing", () => {
    const { observe: _o, ...doc } = boardV2();
    const result = parse(doc);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.observe).toEqual([]);
  });

  it("still reads version 1, as observing nothing", () => {
    const result = parse(board());
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.board_version).toBe(1);
    expect(result.declaration.observe).toEqual([]);
  });

  it("says that version 2 reads observe and a stage's look and notes when version 1 has them", () => {
    const doc = boardV2();
    doc.board_version = 1;
    entry(doc.stages, "03").colour = "red";
    expect(errorsOf(parse(doc))).toEqual([
      "stages.03: unknown key 'colour'",
      "stages.05: 'look', 'notes' are read from board_version 2 on; this file is board_version 1",
      "(top level): 'observe' is read from board_version 2 on; this file is board_version 1",
    ]);
  });

  it("tells a key version 2 reads apart from one no version reads, where it stands", () => {
    const doc = board();
    entry(doc.stages, "02").colour = "red";
    entry(doc.stages, "02").look = ["x"];
    entry(doc.stages, "03").observe = [];
    doc.extra = 1;
    doc.look = ["x"];
    doc.observe = [];
    expect(errorsOf(parse(doc))).toEqual([
      "stages.02: unknown key 'colour'",
      "stages.02: 'look' is read from board_version 2 on; this file is board_version 1",
      "stages.03: unknown key 'observe'",
      "(top level): unknown keys 'extra', 'look'",
      "(top level): 'observe' is read from board_version 2 on; this file is board_version 1",
    ]);
  });

  it("refuses an unknown kind, a kind's missing keys, keys of another kind and a duplicate key", () => {
    const doc = boardV2();
    doc.observe = [
      { key: "a", kind: "rss_feed", url: "https://example.com/" },
      { key: "b", kind: "github_ci", repo: "owner/name" },
      { key: "c", kind: "npm_version", package: "x", repo: "owner/name" },
      { key: "d", kind: "manual" },
      { key: "d", kind: "manual", how: "ask" },
      { kind: "manual", how: "ask" },
      { key: "Bad", kind: "manual", how: "ask" },
    ];
    expect(errorsOf(parse(doc))).toEqual([
      "observe[0].kind: Invalid discriminator value. Expected 'npm_version' | 'github_release' | 'github_open_issues' | 'github_open_prs' | 'github_ci' | 'page_version' | 'manual'",
      "observe[1].workflow: Invalid input: expected string, received undefined",
      "observe[2]: unknown key 'repo' (kind 'npm_version' takes: key, kind, package)",
      "observe[3].how: Invalid input: expected string, received undefined",
      "observe[5].key: Invalid input: expected string, received undefined",
      "observe[6].key: must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
      "observe[4].key: duplicate observation key 'd' (first at observe[3])",
    ]);
  });

  it.each<[string, string]>([
    ["Cli", "uppercase"],
    ["@Scope/cli", "an uppercase scope"],
    ["scope/cli", "a slash without a scope"],
    ["-x", "a leading '-'"],
    ["@scope/-x", "a leading '-' after the scope"],
    ["a b", "a space"],
    ["a;rm", "a ';'"],
    ["@scope", "a scope alone"],
    ["", "nothing"],
    ["a".repeat(215), "too long"],
  ])("refuses the npm package %j (%s)", (pkg) => {
    expect(errorsOf(parse(withObserve({ key: "n", kind: "npm_version", package: pkg })))).toEqual([
      "observe[0].package: must be an npm package name such as name or @scope/name, in lowercase",
    ]);
  });

  it.each<[string]>([
    ["name"],
    ["-owner/name"],
    ["_owner/name"],
    ["owner/name/more"],
    ["owner/.."],
    ["owner/."],
    ["own er/name"],
    ["owner/na'me"],
    [`${"o".repeat(65)}/name`],
    [`owner/${"n".repeat(101)}`],
  ])("refuses the GitHub repository %j", (repo) => {
    for (const kind of ["github_release", "github_open_issues", "github_open_prs"]) {
      expect(errorsOf(parse(withObserve({ key: "g", kind, repo })))).toEqual([
        "observe[0].repo: must be a GitHub repository written as owner/name",
      ]);
    }
  });

  it("takes a managed user's owner, with '_', and names at their longest", () => {
    const doc = boardV2();
    doc.observe = [
      { key: "a", kind: "github_release", repo: "mona_corp/name" },
      { key: "b", kind: "github_release", repo: `${"o".repeat(64)}/${"n".repeat(100)}` },
      { key: "c", kind: "github_ci", repo: "o/n", workflow: `${"w".repeat(251)}.yml` },
    ];
    expect(parse(doc).ok).toBe(true);
  });

  it("refuses a workflow that is not a file name and a branch a command could misread", () => {
    const doc = boardV2();
    doc.observe = [
      { key: "a", kind: "github_ci", repo: "o/n", workflow: ".github/workflows/q.yml" },
      { key: "b", kind: "github_ci", repo: "o/n", workflow: "quality" },
      { key: "c", kind: "github_ci", repo: "o/n", workflow: "-q.yml" },
      { key: "d", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "-x" },
      { key: "e", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "a..b" },
      { key: "f", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "a b" },
      { key: "g", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "release/" },
      { key: "h", kind: "github_ci", repo: "o/n", workflow: "q.yaml", branch: "release/1.x" },
      { key: "i", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "a//b" },
      { key: "j", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "v1." },
      { key: "k", kind: "github_ci", repo: "o/n", workflow: "Q.YML" },
      { key: "l", kind: "github_ci", repo: "o/n", workflow: `${"w".repeat(252)}.yml` },
      { key: "m", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "a/./b" },
      { key: "n", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "release/.x" },
      { key: "o", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch: "a.b/c.d" },
    ];
    const workflow = "must be the file name of a workflow, such as quality.yml";
    // Each says what is wrong with it.
    expect(errorsOf(parse(doc))).toEqual([
      `observe[0].workflow: ${workflow}`,
      `observe[1].workflow: ${workflow}`,
      `observe[2].workflow: ${workflow}`,
      "observe[3].branch: must not start with '-', '.' or '/'",
      "observe[4].branch: must not hold '..'",
      "observe[5].branch: must be a branch name such as main, using only A-Z, a-z, 0-9, '.', '_', '-' and '/'",
      "observe[6].branch: must not end with '.' or '/'",
      "observe[8].branch: must not hold '//'",
      "observe[9].branch: must not end with '.' or '/'",
      `observe[10].workflow: ${workflow}`,
      `observe[11].workflow: ${workflow}`,
      "observe[12].branch: must not have a part that starts with '.' (after a '/')",
      "observe[13].branch: must not have a part that starts with '.' (after a '/')",
    ]);
  });

  it.each<[string, string]>([
    ["http://example.com/", "must be an https:// URL"],
    ["HTTPS://example.com/", "must be an https:// URL"],
    ["ftp://example.com/", "must be an https:// URL"],
    ["example.com", "must be an https:// URL"],
    ["https://", "must name a host"],
    ["https:///example.com", "must name a host"],
    ["https://?a=1", "must name a host"],
    ["https://example.com/a b", "must be printable ASCII with no spaces"],
    ["https://example.com/é", "must be printable ASCII with no spaces"],
    ["https://example.com/'; rm -rf ~", "must be printable ASCII with no spaces"],
    ["https://example.com/a'b", "must not contain quotes, backslashes, '<' or '>'"],
    ["https://example.com/a\\b", "must not contain quotes, backslashes, '<' or '>'"],
    ["https://user:secret@example.com/", "must not carry a user name or a password"],
    ["https://user@example.com/", "must not carry a user name or a password"],
    ["https://:secret@example.com/", "must not carry a user name or a password"],
    ["https://@example.com/", "must not carry a user name or a password"],
    ['https://example.com/a"b', "must not contain quotes, backslashes, '<' or '>'"],
    ["https://example.com/a`b`", "must not contain quotes, backslashes, '<' or '>'"],
    ["https://example.com/<a>", "must not contain quotes, backslashes, '<' or '>'"],
    ["https://exa%zzmple.com/", "must be an https:// URL"],
  ])("refuses the page %j", (url, problem) => {
    expect(errorsOf(parse(withObserve({ key: "p", kind: "page_version", url })))).toEqual([
      `observe[0].url: ${problem}`,
    ]);
  });

  it("takes a page's query and fragment, and a manual observation's how as written", () => {
    const doc = boardV2();
    doc.observe = [
      { key: "p", kind: "page_version", url: "https://example.com:8443/ja/?a=1&b=2#v" },
      { key: "m", kind: "manual", how: "count with `psql`; it's read only, $(not run)" },
    ];
    const result = parse(doc);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.observe).toEqual(doc.observe);
  });

  it("refuses an empty look or note of a stage", () => {
    const doc = boardV2();
    entry(doc.stages, "02").look = [""];
    entry(doc.stages, "02").notes = "not a list";
    expect(errorsOf(parse(doc))).toEqual([
      "stages.02.look[0]: must be a non-empty string",
      "stages.02.notes: Invalid input: expected array, received string",
    ]);
  });
});

// A version 3 board whose only observation is `observe`.
function withHttp(observe: Record<string, unknown>): Record<string, unknown> {
  return { ...boardV2(), board_version: 3, observe: [{ key: "h", kind: "http", ...observe }] };
}

describe("parseBoardDeclaration: board_version 3 and http", () => {
  const url = "https://example.com/shop/item-1";

  it("accepts an http observation with what to read off the body, and one with none", () => {
    const doc: Record<string, unknown> = { ...boardV2(), board_version: 3 };
    const full = {
      key: "shop_item",
      kind: "http",
      url,
      words: ["in stock", "\u5728\u5eab\u3042\u308a", "a\\b", "x-y"],
      count_pattern: "<loc>",
      capture_pattern: "Version ([0-9.]+)",
    };
    doc.observe = [...(doc.observe as unknown[]), full, { key: "bare", kind: "http", url }];
    const result = parse(doc);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.board_version).toBe(3);
    expect(result.declaration.observe.slice(-2)).toEqual([
      full,
      { key: "bare", kind: "http", url },
    ]);
  });

  it("reads a version 2 board as before", () => {
    const result = parse(boardV2());
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.board_version).toBe(2);
  });

  it("refuses a method and any key it does not take, and holds the url to the shape of a page's", () => {
    expect(errorsOf(parse(withHttp({ url, method: "HEAD", status: 200 })))).toEqual([
      "observe[0]: unknown keys 'method', 'status' (kind 'http' takes: key, kind, url, words, count_pattern, capture_pattern, notes)",
    ]);
    expect(errorsOf(parse(withHttp({ url: "http://example.com/" })))).toEqual([
      "observe[0].url: must be an https:// URL",
    ]);
    expect(errorsOf(parse(withHttp({})))).toEqual([
      "observe[0].url: Invalid input: expected string, received undefined",
    ]);
  });

  it("refuses a word list that is empty or not a list, and a word a command could misread", () => {
    expect(errorsOf(parse(withHttp({ url, words: [] })))).toEqual([
      "observe[0].words: must list at least one word",
    ]);
    expect(errorsOf(parse(withHttp({ url, words: "in stock" })))).toEqual([
      "observe[0].words: Invalid input: expected array, received string",
    ]);
    expect(
      errorsOf(parse(withHttp({ url, words: ["", "  ", "a\tb", "a\u0085b", "-p", "it's", 1] }))),
    ).toEqual([
      "observe[0].words[0]: must be a non-empty string",
      "observe[0].words[2]: must not contain control characters",
      "observe[0].words[3]: must not contain control characters",
      "observe[0].words[4]: must not start with '-'",
      'observe[0].words[5]: must not contain "\'"',
      "observe[0].words[6]: Invalid input: expected string, received number",
    ]);
    // Only the empty text is empty, and a '-' after a space starts no option.
    expect(parse(withHttp({ url, words: [" ", " -p", "In Stock"] })).ok).toBe(true);
  });

  it("refuses an http key that is not an id: the guide names a working file by it", () => {
    for (const key of ["Shop", "a/b", "a:b", "-a", "a b", "a.", "a..b", ".a", "a.B"]) {
      expect(errorsOf(parse(withHttp({ key, url })))).toEqual([
        "observe[0].key: must start with a lowercase letter and use only a-z, 0-9, '_', '-' and '.', with a lowercase letter after each '.'",
      ]);
    }
  });

  it("looks for a word given twice only in an http observation", () => {
    const doc = withHttp({ url });
    doc.observe = [{ key: "m", kind: "manual", how: "ask", words: ["a", "a"] }];
    expect(errorsOf(parse(doc))).toEqual([
      "observe[0]: unknown key 'words' (kind 'manual' takes: key, kind, how, notes)",
    ]);
  });

  it("refuses a word given twice, saying where it was first", () => {
    expect(errorsOf(parse(withHttp({ url, words: ["a", "b", "a", "b", "a"] })))).toEqual([
      "observe[0].words[2]: duplicate word (first at words[0])",
      "observe[0].words[3]: duplicate word (first at words[1])",
      "observe[0].words[4]: duplicate word (first at words[0])",
    ]);
  });

  it("refuses a count_pattern that does not compile with gu, matches the empty string or a command could misread", () => {
    const at = (count_pattern: unknown) => errorsOf(parse(withHttp({ url, count_pattern })));
    const empty =
      "observe[0].count_pattern: must not match the empty string: each match is counted";
    // \p{L}* matches the empty string only under the u flag, ^$ only in the empty text.
    for (const pattern of ["a*", "x?", "^", "$", "(?:)", "a|", "[a-z]{0,3}", "\\p{L}*", "^$"]) {
      expect(at(pattern)).toEqual([empty]);
    }
    // Only the empty text is empty: a pattern of a space counts spaces.
    expect(parse(withHttp({ url, count_pattern: " " })).ok).toBe(true);
    expect(at("")).toEqual(["observe[0].count_pattern: must be a non-empty string"]);
    expect(at("-x")).toEqual(["observe[0].count_pattern: must not start with '-'"]);
    expect(at("a\nb")).toEqual(["observe[0].count_pattern: must not contain control characters"]);
    expect(at("content='x'")).toEqual([
      'observe[0].count_pattern: must not contain "\'" (match one as \\x27)',
    ]);
    const [broken] = at("(");
    expect(broken).toMatch(
      /^observe\[0\]\.count_pattern: is not a valid regular expression with the 'gu' flags \(/,
    );
    // An escape the u flag refuses, which a pattern without it would take.
    expect(at("\\-")[0]).toMatch(/with the 'gu' flags/);
    for (const pattern of ["<loc>", "^#", "end$", "content=\\x27x\\x27", "\\p{L}+"]) {
      expect(parse(withHttp({ url, count_pattern: pattern })).ok).toBe(true);
    }
  });

  it("refuses a capture_pattern with no capturing group, or one that does not compile with u", () => {
    const at = (capture_pattern: unknown) => errorsOf(parse(withHttp({ url, capture_pattern })));
    const group =
      "observe[0].capture_pattern: must have a capturing group: the value is what the first one holds";
    expect(at("Version [0-9.]+")).toEqual([group]);
    expect(at("Version (?:[0-9.]+)")).toEqual([group]);
    expect(at("-(x)")).toEqual(["observe[0].capture_pattern: must not start with '-'"]);
    expect(at("(")[0]).toMatch(/with the 'u' flags \(/);
    for (const pattern of ["Version ([0-9.]+)", "(?<v>[0-9]+)", "a*(b)?", "^(.*)$"]) {
      expect(parse(withHttp({ url, capture_pattern: pattern })).ok).toBe(true);
    }
  });

  it("says that version 3 reads http when version 2 or 1 has it, apart from what no version reads", () => {
    const doc = boardV2();
    doc.observe = [
      { key: "a", kind: "http", url, words: ["x"] },
      { key: "b", kind: "rss_feed", url },
      { key: "c", kind: "http", url: "http://example.com/" },
    ];
    expect(errorsOf(parse(doc))).toEqual([
      "observe[0].kind: 'http' is read from board_version 3 on; this file is board_version 2",
      "observe[1].kind: Invalid discriminator value. Expected 'npm_version' | 'github_release' | 'github_open_issues' | 'github_open_prs' | 'github_ci' | 'page_version' | 'manual'",
      "observe[2].kind: 'http' is read from board_version 3 on; this file is board_version 2",
    ]);
    // Version 1 reads no observe at all: the key is put down to the version that reads it as written.
    const v1 = board();
    v1.observe = [{ key: "a", kind: "http", url }];
    expect(errorsOf(parse(v1))).toEqual([
      "(top level): 'observe' is read from board_version 3 on; this file is board_version 1",
    ]);
    v1.observe = [{ key: "a", kind: "npm_version", package: "x" }];
    entry(v1.stages, "02").look = ["x"];
    expect(errorsOf(parse(v1))).toEqual([
      "stages.02: 'look' is read from board_version 2 on; this file is board_version 1",
      "(top level): 'observe' is read from board_version 2 on; this file is board_version 1",
    ]);
  });

  it("holds a file with no version, or one that is not a number, to the newest shape", () => {
    const reads = "board_version: must be a board version this basou reads (1, 2 or 3)";
    for (const version of [undefined, "2", "3"]) {
      expect(errorsOf(parse({ ...withHttp({ url }), board_version: version }))).toEqual([reads]);
    }
  });

  it("does not put a problem down to a later version that refuses the same part", () => {
    const doc = boardV2();
    doc.observe = [{ key: "a", kind: "http" }];
    // Version 3 takes the kind but not the entry without its url: still read from 3 on.
    expect(errorsOf(parse(doc))).toEqual([
      "observe[0].kind: 'http' is read from board_version 3 on; this file is board_version 2",
    ]);
    const v1 = board();
    // No version reads the key as written (3 refuses the entry inside it), but
    // what version 2 refuses inside it is a kind version 3 reads: from 3 on.
    for (const http of [
      { key: "a", kind: "http" },
      { key: "a", kind: "http", url: "http://example.com/" },
      { key: "a", kind: "http", url, words: ["-p"] },
      { key: "a", kind: "http", url, method: "GET" },
    ]) {
      v1.observe = [http];
      expect(errorsOf(parse(v1))).toEqual([
        "(top level): 'observe' is read from board_version 3 on; this file is board_version 1",
      ]);
    }
    // What every version refuses inside it: put down to the first version that takes the key.
    v1.observe = [{ key: "a", kind: "manual" }];
    expect(errorsOf(parse(v1))).toEqual([
      "(top level): 'observe' is read from board_version 2 on; this file is board_version 1",
    ]);
    // A key no shape takes inside it does not keep it from being taken.
    v1.observe = [{ key: "a", kind: "manual", how: "ask", words: ["x"] }];
    expect(errorsOf(parse(v1))).toEqual([
      "(top level): 'observe' is read from board_version 2 on; this file is board_version 1",
    ]);
    v1.observe = "not a list";
    entry(v1.stages, "02").look = [""];
    expect(errorsOf(parse(v1))).toEqual([
      "stages.02: 'look' is read from board_version 2 on; this file is board_version 1",
      "(top level): 'observe' is read from board_version 2 on; this file is board_version 1",
    ]);
  });
});

// A version 3 board whose only observation is a github_check with `over`.
function withCheck(over: Record<string, unknown>): Record<string, unknown> {
  return {
    ...boardV2(),
    board_version: 3,
    observe: [{ key: "deploy", kind: "github_check", repo: "owner/name", ...over }],
  };
}

describe("parseBoardDeclaration: board_version 3, github_check and an observation's notes", () => {
  it("accepts a check run by its name, filling the default branch, and a branch of its own", () => {
    const names = [
      "Workers Builds: my-app",
      "Quality checks (typecheck / build / test / lint)",
      'a`b $(c) "d" ; e',
      "\u30c7\u30d7\u30ed\u30a4",
      "c".repeat(255),
      // Characters, not UTF-16 code units: each of these is two.
      "\u{1F680}".repeat(255),
    ];
    for (const check of names) {
      const result = parse(withCheck({ check }));
      if (!result.ok) throw new Error(result.errors.join("\n"));
      expect(result.declaration.observe).toEqual([
        { key: "deploy", kind: "github_check", repo: "owner/name", check, branch: "main" },
      ]);
    }
    const result = parse(withCheck({ check: "deploy", branch: "release/1.x" }));
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.observe[0]).toMatchObject({ branch: "release/1.x" });
  });

  it("refuses a check name a command could misread, too long, or missing", () => {
    const at = (check: unknown) => errorsOf(parse(withCheck({ check })));
    expect(at("")).toEqual(["observe[0].check: must be a non-empty string"]);
    expect(at("-deploy")).toEqual(["observe[0].check: must not start with '-'"]);
    expect(at("it's")).toEqual([`observe[0].check: must not contain "'"`]);
    expect(at("a\tb")).toEqual(["observe[0].check: must not contain control characters"]);
    expect(at("a\u009bb")).toEqual(["observe[0].check: must not contain control characters"]);
    expect(at("c".repeat(256))).toEqual(["observe[0].check: must be at most 255 characters"]);
    expect(at("\u{1F680}".repeat(256))).toEqual([
      "observe[0].check: must be at most 255 characters",
    ]);
    expect(at(1)).toEqual(["observe[0].check: Invalid input: expected string, received number"]);
    expect(errorsOf(parse(withCheck({})))).toEqual([
      "observe[0].check: Invalid input: expected string, received undefined",
    ]);
  });

  it("holds the repo and the branch to github_ci's shapes, and takes no workflow", () => {
    expect(errorsOf(parse(withCheck({ check: "x", repo: "name" })))).toEqual([
      "observe[0].repo: must be a GitHub repository written as owner/name",
    ]);
    for (const [branch, problem] of [
      ["-x", "must not start with '-', '.' or '/'"],
      ["a/./b", "must not have a part that starts with '.' (after a '/')"],
      ["release/.x", "must not have a part that starts with '.' (after a '/')"],
      [
        "a b",
        "must be a branch name such as main, using only A-Z, a-z, 0-9, '.', '_', '-' and '/'",
      ],
    ]) {
      expect(errorsOf(parse(withCheck({ check: "x", branch }))), branch).toEqual([
        `observe[0].branch: ${problem}`,
      ]);
    }
    expect(parse(withCheck({ check: "x", branch: "a.b/c.d" })).ok).toBe(true);
    expect(errorsOf(parse(withCheck({ check: "x", workflow: "q.yml" })))).toEqual([
      "observe[0]: unknown key 'workflow' (kind 'github_check' takes: key, kind, repo, check, branch, notes)",
    ]);
    const ci = withCheck({});
    ci.observe = [{ key: "ci", kind: "github_ci", repo: "o/n", workflow: "q.yml", check: "x" }];
    expect(errorsOf(parse(ci))).toEqual([
      "observe[0]: unknown key 'check' (kind 'github_ci' takes: key, kind, repo, workflow, branch, notes)",
    ]);
  });

  it("takes notes on every kind of observation, kept as written", () => {
    const notes = ["404 is right while it is sold out", "`ask` first"];
    const doc: Record<string, unknown> = {
      ...boardV2(),
      board_version: 3,
      observe: [
        ...(boardV2().observe as Record<string, unknown>[]),
        { key: "deploy", kind: "github_check", repo: "owner/name", check: "deploy" },
        { key: "shop", kind: "http", url: "https://example.com/" },
      ].map((o) => ({ ...o, notes })),
    };
    const result = parse(doc);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.observe.map((o) => o.kind).sort()).toEqual(
      [...BOARD_OBSERVE_KINDS].sort(),
    );
    for (const o of result.declaration.observe) expect(o.notes).toEqual(notes);
    // An observation without notes has none.
    const bare = parse(withCheck({ check: "x" }));
    if (!bare.ok) throw new Error(bare.errors.join("\n"));
    expect(bare.declaration.observe[0]).not.toHaveProperty("notes");
  });

  it("refuses notes that are not a list of non-empty strings", () => {
    expect(errorsOf(parse(withCheck({ check: "x", notes: "mind" })))).toEqual([
      "observe[0].notes: Invalid input: expected array, received string",
    ]);
    expect(errorsOf(parse(withCheck({ check: "x", notes: ["", " ", 1] })))).toEqual([
      "observe[0].notes[0]: must be a non-empty string",
      "observe[0].notes[1]: must be a non-empty string",
      "observe[0].notes[2]: Invalid input: expected string, received number",
    ]);
  });

  it("names github_check among the kinds a version 3 board reads", () => {
    expect(errorsOf(parse(withCheck({ kind: "rss_feed" })))).toEqual([
      "observe[0].kind: Invalid discriminator value. Expected 'npm_version' | 'github_release' | 'github_open_issues' | 'github_open_prs' | 'github_ci' | 'github_check' | 'page_version' | 'http' | 'manual'",
    ]);
  });

  it("says that version 3 reads github_check and notes when version 2 or 1 has them", () => {
    const doc = boardV2();
    doc.observe = [
      { key: "a", kind: "github_check", repo: "owner/name", check: "deploy" },
      { key: "b", kind: "npm_version", package: "x", notes: ["mind"] },
      { key: "c", kind: "manual", how: "ask", notes: [""] },
      { key: "d", kind: "github_check", repo: "owner/name", check: "-x" },
      { key: "e", kind: "manual", how: "ask", notes: ["mind"], colour: "red" },
    ];
    expect(errorsOf(parse(doc))).toEqual([
      "observe[0].kind: 'github_check' is read from board_version 3 on; this file is board_version 2",
      "observe[1]: 'notes' is read from board_version 3 on; this file is board_version 2",
      "observe[2]: 'notes' is read from board_version 3 on; this file is board_version 2",
      "observe[3].kind: 'github_check' is read from board_version 3 on; this file is board_version 2",
      "observe[4]: unknown key 'colour' (kind 'manual' takes: key, kind, how)",
      "observe[4]: 'notes' is read from board_version 3 on; this file is board_version 2",
    ]);
    const v1 = board();
    for (const observe of [
      [{ key: "a", kind: "github_check", repo: "owner/name", check: "deploy" }],
      [{ key: "a", kind: "manual", how: "ask", notes: ["mind"] }],
      [{ key: "a", kind: "manual", how: "ask", notes: [""] }],
    ]) {
      v1.observe = observe;
      expect(errorsOf(parse(v1))).toEqual([
        "(top level): 'observe' is read from board_version 3 on; this file is board_version 1",
      ]);
    }
  });
});

// A version 3 board whose only measure is `measure`.
function withMeasureV3(measure: Record<string, unknown>): Record<string, unknown> {
  return { ...withMeasure(measure), board_version: 3 };
}

const LATEST = {
  id: "latest_migration",
  kind: "file_name",
  repo: "../basou",
  include: ["db/migrations/*.sql"],
  pick: "last",
  unit: "name",
};

const MIGRATIONS = {
  id: "migrations",
  kind: "file_paths",
  repo: "../basou",
  include: ["db/migrations/*.sql"],
  unit: "files",
};

describe("parseBoardDeclaration: board_version 3, file_name and file_paths", () => {
  it("accepts a file_name, with no group without a pattern and group 1 by default with one", () => {
    const bare = parse(withMeasureV3(LATEST));
    if (!bare.ok) throw new Error(bare.errors.join("\n"));
    expect(bare.declaration.measures).toEqual([{ ...LATEST, at: "worktree" }]);
    expect(Object.hasOwn(bare.declaration.measures[0] as object, "group")).toBe(false);

    const dated = parse(
      withMeasureV3({ ...LATEST, pick: "first", pattern: "^(\\d{8})_", exclude: ["**/x.sql"] }),
    );
    if (!dated.ok) throw new Error(dated.errors.join("\n"));
    expect(dated.declaration.measures[0]).toEqual({
      ...LATEST,
      pick: "first",
      pattern: "^(\\d{8})_",
      exclude: ["**/x.sql"],
      at: "worktree",
      group: 1,
    });

    for (const group of [0, 2]) {
      const named = parse(
        withMeasureV3({ ...LATEST, pattern: "^(\\d{4})(\\d{4})_", group, at: "main" }),
      );
      if (!named.ok) throw new Error(named.errors.join("\n"));
      expect(named.declaration.measures[0]).toMatchObject({ group, at: "main" });
    }
  });

  it("accepts a file_paths, with a lane", () => {
    const result = parse(withMeasureV3({ ...MIGRATIONS, lane: "cockpit", at: "v1.0" }));
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.measures).toEqual([{ ...MIGRATIONS, lane: ["cockpit"], at: "v1.0" }]);
  });

  it("refuses a file_name with no pick or another, a group with no pattern or past its groups, and what it does not take", () => {
    const at = (over: Record<string, unknown>) =>
      errorsOf(parse(withMeasureV3({ ...LATEST, ...over })));
    expect(at({ pick: undefined })).toEqual(["measures[0].pick: must be first or last"]);
    expect(at({ pick: "middle" })).toEqual(["measures[0].pick: must be first or last"]);
    expect(at({ group: 1 })).toEqual([
      "measures[0].group: a file_name takes a group only with a pattern",
    ]);
    expect(at({ pattern: "^(\\d{8})_", group: 2 })).toEqual([
      "measures[0].group: the pattern has 1 capturing group, so group 2 does not exist",
    ]);
    expect(at({ pattern: "^\\d{8}_" })).toEqual([
      "measures[0].group: the pattern has 0 capturing groups, so group 1 does not exist",
    ]);
    expect(at({ pattern: "(" })[0]).toMatch(
      /^measures\[0\]\.pattern: is not a valid regular expression with the 'u' flag/,
    );
    expect(at({ group: -1, pattern: "(a)" })[0]).toMatch(/^measures\[0\]\.group: /);
    expect(at({ include: undefined })).toEqual([
      "measures[0].include: Invalid input: expected array, received undefined",
    ]);
    expect(at({ file: "a.sql" })).toEqual([
      "measures[0]: unknown key 'file' (kind 'file_name' takes: kind, id, unit, lane, repo, at, include, exclude, pick, pattern, group)",
    ]);
    expect(at({ repo: "../elsewhere" })).toEqual([
      "measures[0].repo: '../elsewhere' is not a repo path in the manifest (the manifest declares '.', '../basou')",
    ]);
  });

  it("refuses what a file_paths does not take, and a repo the manifest does not declare", () => {
    const at = (over: Record<string, unknown>) =>
      errorsOf(parse(withMeasureV3({ ...MIGRATIONS, ...over })));
    expect(at({ pick: "last" })).toEqual([
      "measures[0]: unknown key 'pick' (kind 'file_paths' takes: kind, id, unit, lane, repo, at, include, exclude)",
    ]);
    expect(at({ pattern: "x" })).toEqual([
      "measures[0]: unknown key 'pattern' (kind 'file_paths' takes: kind, id, unit, lane, repo, at, include, exclude)",
    ]);
    expect(at({ include: [] })).toEqual(["measures[0].include: must list at least one path"]);
    expect(at({ repo: "../elsewhere" })).toEqual([
      "measures[0].repo: '../elsewhere' is not a repo path in the manifest (the manifest declares '.', '../basou')",
    ]);
  });

  it("refuses a ratio of a file_name or a file_paths, as of a regex_capture", () => {
    const doc = withMeasureV3(LATEST);
    doc.measures = [
      LATEST,
      MIGRATIONS,
      {
        id: "src_lines",
        kind: "line_count",
        repo: "../basou",
        include: ["**/*.ts"],
        unit: "lines",
      },
    ];
    doc.ratios = [
      { id: "a", label: "a", numerator: "latest_migration", denominator: "src_lines" },
      { id: "b", label: "b", numerator: "src_lines", denominator: "migrations" },
    ];
    expect(errorsOf(parse(doc))).toEqual([
      "ratios[0].numerator: 'latest_migration' is a file_name, which is not a number",
      "ratios[1].denominator: 'migrations' is a file_paths, which is not a number",
    ]);
  });

  it("names file_name and file_paths among the kinds of measure a version 3 board reads", () => {
    expect(errorsOf(parse(withMeasureV3({ ...MIGRATIONS, kind: "file_names" })))).toEqual([
      "measures[0].kind: Invalid discriminator value. Expected 'file_count' | 'dir_count' | 'line_count' | 'match_count' | 'regex_capture' | 'json_length' | 'file_name' | 'file_paths' | 'trail_count' | 'total'",
    ]);
  });

  it("says that version 3 reads file_name and file_paths when version 2 or 1 has them", () => {
    for (const version of [1, 2]) {
      const doc = version === 1 ? board() : boardV2();
      doc.measures = [LATEST, MIGRATIONS, { ...LATEST, id: "c", pick: "middle" }];
      doc.ratios = [];
      expect(errorsOf(parse(doc))).toEqual([
        `measures[0].kind: 'file_name' is read from board_version 3 on; this file is board_version ${version}`,
        `measures[1].kind: 'file_paths' is read from board_version 3 on; this file is board_version ${version}`,
        `measures[2].kind: 'file_name' is read from board_version 3 on; this file is board_version ${version}`,
      ]);
    }
  });
});

const SRC_LINES = {
  id: "src_lines",
  kind: "line_count",
  repo: "../basou",
  include: ["**/*.ts"],
  unit: "lines",
};

const LEFT = { id: "left", kind: "total", plus: [100], minus: ["src_lines"], unit: "lines" };

// A version 3 board whose measures are src_lines and `measures`.
function withTotals(...measures: Record<string, unknown>[]): Record<string, unknown> {
  return { ...board(), board_version: 3, measures: [SRC_LINES, ...measures], ratios: [] };
}

const DOTTED_ID =
  "must start with a lowercase letter and use only a-z, 0-9, '_', '-' and '.', with a lowercase letter after each '.'";

describe("parseBoardDeclaration: board_version 3, total", () => {
  it("accepts a total of integers and measures, with or without what it takes away", () => {
    const all = { id: "all", kind: "total", plus: ["src_lines", -2, 0], unit: "lines" };
    const result = parse(withTotals(LEFT, { ...all, lane: "cockpit" }));
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.measures.slice(1)).toEqual([LEFT, { ...all, lane: ["cockpit"] }]);
  });

  it("refuses a total with no plus, an empty plus or minus, a term that is not an integer or an id, and what it does not take", () => {
    const at = (over: Record<string, unknown>) => errorsOf(parse(withTotals({ ...LEFT, ...over })));
    expect(at({ plus: undefined })).toEqual([
      "measures[1].plus: Invalid input: expected array, received undefined",
    ]);
    expect(at({ plus: [] })).toEqual([
      "measures[1].plus: must list at least one integer or measure id",
    ]);
    expect(at({ minus: [] })).toEqual([
      "measures[1].minus: must list at least one integer or measure id",
    ]);
    expect(at({ plus: "src_lines" })).toEqual([
      "measures[1].plus: Invalid input: expected array, received string",
    ]);
    const integer = "must be an integer from -9007199254740991 to 9007199254740991";
    const id =
      "must be an integer or the id of a measure, which starts with a lowercase letter and uses only a-z, 0-9, '_', '-' and '.', with a lowercase letter after each '.'";
    expect(at({ plus: [1.5, "Src", true, null, "src.", 2 ** 53, "100"] })).toEqual([
      `measures[1].plus[0]: ${integer}`,
      `measures[1].plus[1]: ${id}`,
      "measures[1].plus[2]: must be an integer or the id of a measure",
      "measures[1].plus[3]: must be an integer or the id of a measure",
      `measures[1].plus[4]: ${id}`,
      `measures[1].plus[5]: ${integer}`,
      `measures[1].plus[6]: ${id}`,
    ]);
    // Integers, but not ones a number holds exactly.
    expect(
      at({ plus: [2 ** 53, -(2 ** 53), 1e300], minus: [2 ** 53 - 1, -(2 ** 53 - 1)] }),
    ).toEqual([
      `measures[1].plus[0]: ${integer}`,
      `measures[1].plus[1]: ${integer}`,
      `measures[1].plus[2]: ${integer}`,
    ]);
    expect(at({ repo: "../basou", at: "main" })).toEqual([
      "measures[1]: unknown keys 'repo', 'at' (kind 'total' takes: kind, id, unit, lane, plus, minus)",
    ]);
  });

  it("refuses a term that names no measure, a total, itself included, or a measure that is not a number", () => {
    const doc = withTotals(
      LATEST,
      {
        id: "cap",
        kind: "regex_capture",
        repo: "../basou",
        file: "a.md",
        pattern: "(x)",
        unit: "x",
      },
      MIGRATIONS,
      {
        id: "t",
        kind: "total",
        plus: ["t", "nope", 1, "no.such"],
        minus: ["src_lines"],
        unit: "x",
      },
      {
        id: "u",
        kind: "total",
        plus: [1],
        minus: ["latest_migration", "cap", "migrations", "u", "t"],
        unit: "x",
      },
    );
    expect(errorsOf(parse(doc))).toEqual([
      "measures[4].plus[0]: 't' is a total, which no total takes",
      "measures[4].plus[1]: no measure has the id 'nope'",
      "measures[4].plus[3]: no measure has the id 'no.such'",
      "measures[5].minus[0]: 'latest_migration' is a file_name, which is not a number",
      "measures[5].minus[1]: 'cap' is a regex_capture, which is not a number",
      "measures[5].minus[2]: 'migrations' is a file_paths, which is not a number",
      "measures[5].minus[3]: 'u' is a total, which no total takes",
      "measures[5].minus[4]: 't' is a total, which no total takes",
    ]);
  });

  it("takes a total in a ratio", () => {
    const doc = withTotals(LEFT);
    doc.ratios = [{ id: "r", label: "r", numerator: "left", denominator: "src_lines" }];
    expect(parse(doc).ok).toBe(true);
  });
});

describe("parseBoardDeclaration: board_version 3, a measure's lanes", () => {
  const withLane = (lane: unknown) => withMeasureV3({ ...MIGRATIONS, lane });

  it("reads one lane id, or a list of them, as a list", () => {
    for (const [lane, read] of [
      ["cockpit", ["cockpit"]],
      [["cockpit"], ["cockpit"]],
      [
        ["cockpit", "saddle"],
        ["cockpit", "saddle"],
      ],
    ] as const) {
      const result = parse(withLane(lane));
      if (!result.ok) throw new Error(result.errors.join("\n"));
      expect(result.declaration.measures[0]?.lane).toEqual(read);
    }
    const bare = parse(withMeasureV3(MIGRATIONS));
    if (!bare.ok) throw new Error(bare.errors.join("\n"));
    expect(Object.hasOwn(bare.declaration.measures[0] as object, "lane")).toBe(false);
    // The one lane id of a version 1 or 2 board is read as a list of one.
    for (const doc of [board(), boardV2()]) {
      const result = parse(doc);
      if (!result.ok) throw new Error(result.errors.join("\n"));
      expect(result.declaration.measures[0]?.lane).toEqual(["cockpit"]);
    }
  });

  it("refuses an empty list, a lane listed twice or not on the board, and what is not a lane id", () => {
    expect(errorsOf(parse(withLane([])))).toEqual([
      "measures[0].lane: must list at least one lane id",
    ]);
    expect(errorsOf(parse(withLane(["cockpit", "nope", "cockpit", "saddle"])))).toEqual([
      "measures[0].lane[1]: no lane has the id 'nope'",
      "measures[0].lane[2]: 'cockpit' is listed twice",
    ]);
    // A lane not on the board is still listed twice.
    expect(errorsOf(parse(withLane(["nope", "nope"])))).toEqual([
      "measures[0].lane[0]: no lane has the id 'nope'",
      "measures[0].lane[1]: 'nope' is listed twice",
    ]);
    expect(errorsOf(parse(withLane("nope")))).toEqual([
      "measures[0].lane: no lane has the id 'nope'",
    ]);
    const laneId = "must start with a lowercase letter and use only a-z, 0-9, '_' and '-'";
    expect(errorsOf(parse(withLane(["Cockpit", "saddle"])))).toEqual([
      `measures[0].lane[0]: ${laneId}`,
    ]);
    // A lane id holds no '.', as a measure id may.
    expect(errorsOf(parse(withLane("cockpit.a")))).toEqual([`measures[0].lane: ${laneId}`]);
    expect(errorsOf(parse(withLane(5)))).toEqual([
      "measures[0].lane: must be a lane id or a non-empty list of lane ids",
    ]);
    expect(errorsOf(parse(withLane(["cockpit", 5])))).toEqual([
      "measures[0].lane: must be a lane id or a non-empty list of lane ids",
    ]);
  });
});

describe("parseBoardDeclaration: board_version 3, a measure id and an observation key with '.'", () => {
  it("accepts words joined by '.', and a ratio and a total that name such a measure", () => {
    const pages = (id: string) => ({
      id,
      kind: "file_count",
      repo: "../basou",
      include: [`${id}/*.md`],
      unit: "pages",
    });
    const doc: Record<string, unknown> & {
      measures: Record<string, unknown>[];
      observe: Record<string, unknown>[];
    } = {
      ...board(),
      board_version: 3,
      measures: [
        pages("site.pages"),
        pages("site.pages.en"),
        pages("site"),
        { id: "all.pages", kind: "total", plus: ["site.pages", "site.pages.en"], unit: "pages" },
      ],
      ratios: [{ id: "en", label: "en", numerator: "site.pages.en", denominator: "all.pages" }],
      observe: [
        { key: "site.en.version", kind: "page_version", url: "https://example.com/" },
        { key: "shop.item-1", kind: "http", url: "https://example.com/i" },
      ],
    };
    const result = parse(doc);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.measures.map((m) => m.id)).toEqual([
      "site.pages",
      "site.pages.en",
      "site",
      "all.pages",
    ]);
    expect(result.declaration.observe.map((o) => o.key)).toEqual([
      "site.en.version",
      "shop.item-1",
    ]);
    doc.measures = [...doc.measures, pages("site.pages")];
    doc.observe = [...doc.observe, { key: "shop.item-1", kind: "manual", how: "ask" }];
    expect(errorsOf(parse(doc))).toEqual([
      "measures[4].id: duplicate measure id 'site.pages' (first at measures[0])",
      "observe[2].key: duplicate observation key 'shop.item-1' (first at observe[1])",
    ]);
  });

  it("refuses a '.' at an end or after another, a word that starts with no lowercase letter, ':' and '/'", () => {
    for (const id of [
      "a.",
      ".a",
      "a..b",
      "a.B",
      "a.1",
      "a._",
      "a:b",
      "a/b",
      "a. b",
      "site.pages.",
      "a.b..c",
      "a.b._x",
      "a.b.C",
      "a.b.c:d",
    ]) {
      expect(errorsOf(parse(withMeasureV3({ ...MIGRATIONS, id }))), id).toEqual([
        `measures[0].id: ${DOTTED_ID}`,
      ]);
      expect(errorsOf(parse(withHttp({ key: id, url: "https://example.com/" }))), id).toEqual([
        `observe[0].key: ${DOTTED_ID}`,
      ]);
    }
    const doc = withTotals(LEFT);
    doc.ratios = [{ id: "r", label: "r", numerator: "src.", denominator: "no.such" }];
    expect(errorsOf(parse(doc))).toEqual([
      `ratios[0].numerator: ${DOTTED_ID}`,
      "ratios[0].denominator: no measure has the id 'no.such'",
    ]);
  });

  it("keeps '.' out of a lane id and a ratio id", () => {
    const laneId = "must start with a lowercase letter and use only a-z, 0-9, '_' and '-'";
    const doc = withTotals(LEFT);
    doc.lanes = [...(doc.lanes as unknown[]), { id: "a.b", name: "A" }];
    doc.ratios = [{ id: "r.s", label: "r", numerator: "left", denominator: "src_lines" }];
    expect(errorsOf(parse(doc))).toEqual([`lanes[2].id: ${laneId}`, `ratios[0].id: ${laneId}`]);
  });
});

describe("parseBoardDeclaration: what version 3 reads, in a board of version 1 or 2", () => {
  it("says that version 3 reads a total, a list of lanes, and an id or a key with '.'", () => {
    for (const version of [1, 2]) {
      const doc = version === 1 ? board() : boardV2();
      doc.measures = [
        { ...SRC_LINES, lane: ["saddle", "cockpit"] },
        { id: "site.pages", kind: "file_count", repo: "../basou", include: ["s/*"], unit: "p" },
        LEFT,
      ];
      doc.ratios = [{ id: "r", label: "r", numerator: "site.pages", denominator: "src_lines" }];
      doc.observe = [{ key: "site.en", kind: "page_version", url: "https://example.com/" }];
      const told = (where: string, what: string) =>
        `${where}: ${what} read from board_version 3 on; this file is board_version ${version}`;
      expect(errorsOf(parse(doc))).toEqual([
        told("measures[0].lane", "what is written here is"),
        told("measures[1].id", "'site.pages' is"),
        told("measures[2].kind", "'total' is"),
        told("ratios[0].numerator", "'site.pages' is"),
        version === 1
          ? told("(top level)", "'observe' is")
          : told("observe[0].key", "'site.en' is"),
      ]);
    }
  });

  it("holds what version 3 reads against the rest of the board, beside the line saying so", () => {
    for (const version of [1, 2]) {
      const doc = version === 1 ? board() : boardV2();
      doc.measures = [
        { ...SRC_LINES, lane: ["nope", "nope"] },
        { ...LEFT, plus: ["gone"], minus: ["src_lines"] },
      ];
      doc.ratios = [];
      const told = (where: string, what: string) =>
        `${where}: ${what} read from board_version 3 on; this file is board_version ${version}`;
      expect(errorsOf(parse(doc))).toEqual([
        told("measures[0].lane", "what is written here is"),
        told("measures[1].kind", "'total' is"),
        "measures[0].lane[0]: no lane has the id 'nope'",
        "measures[0].lane[1]: 'nope' is listed twice",
        "measures[1].plus[0]: no measure has the id 'gone'",
      ]);
    }
  });
});

describe("parseBoardDeclaration: board_version 3, a component's marker", () => {
  const withComponents = (components: Record<string, unknown>, version = 3) => ({
    ...board(),
    board_version: version,
    components,
  });
  const markerOf = (marker: unknown) =>
    parse(withComponents({ "basou/tools": { lane: "-", note: "scripts", marker } }));

  it("reads a marker of a directory inside a repo, and none where none is written", () => {
    const result = parse(
      withComponents({
        "basou/content": { lane: ["saddle"], note: "data", marker: "**" },
        "basou/tools": { lane: "-", note: "scripts", marker: "*.py" },
        "basou/packages/sdk": { lane: ["saddle"] },
        // A key whose repo the manifest does not declare is not refused.
        "elsewhere/x": { lane: ["saddle"], marker: "." },
      }),
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const { components } = result.declaration;
    expect(components["basou/content"]?.marker).toBe("**");
    expect(components["basou/tools"]?.marker).toBe("*.py");
    expect(components["elsewhere/x"]?.marker).toBe(".");
    expect(Object.hasOwn(components["basou/packages/sdk"] as object, "marker")).toBe(false);
  });

  it("refuses a marker that would leave the component's directory, as an include is refused", () => {
    const relative = "must be relative to the component's directory";
    for (const [marker, message] of [
      ["", "must be a non-empty path"],
      ["/x", relative],
      ["\\\\server\\share", relative],
      ["C:/x", `${relative} (a leading 'x:' reads as a Windows drive)`],
      ["x:y.md", `${relative} (a leading 'x:' reads as a Windows drive)`],
      ["../x", "must not contain a '..' segment"],
      ["a/../../x", "must not contain a '..' segment"],
      ["a\\..\\x", "must not contain a '..' segment"],
      ["..", "must not contain a '..' segment"],
      [":(top)*.md", "must not start with ':' (pathspec magic)"],
      ["a\u0007b", "must not contain control characters"],
      ["a\u0085b", "must not contain control characters"],
    ] as const) {
      expect(errorsOf(markerOf(marker)), marker).toEqual([
        `components["basou/tools"].marker: ${message}`,
      ]);
    }
    expect(errorsOf(markerOf(1))).toEqual([
      'components["basou/tools"].marker: Invalid input: expected string, received number',
    ]);
    // As in an include: '..' inside a name, and '.' as a directory.
    for (const marker of ["a..b/*.md", "./*.md", "."]) {
      expect(markerOf(marker).ok, marker).toBe(true);
    }
  });

  it("refuses a marker on a key that is a repo itself", () => {
    const itself =
      "only a directory inside a repo takes a marker, keyed '<repo>/<path in it>'; this key is a repo itself";
    expect(
      errorsOf(
        parse(
          withComponents({
            basou: { lane: ["saddle"], marker: "**" },
            "basou/": { lane: ["saddle"], marker: "**" },
            "basou/x": { lane: ["saddle"], marker: "**" },
            other: { lane: ["saddle"] },
          }),
        ),
      ),
    ).toEqual([`components.basou.marker: ${itself}`, `components["basou/"].marker: ${itself}`]);
    // Said even when the marker is itself refused.
    expect(
      errorsOf(parse(withComponents({ basou: { lane: ["saddle"], marker: "../x" } }))),
    ).toEqual([
      "components.basou.marker: must not contain a '..' segment",
      `components.basou.marker: ${itself}`,
    ]);
  });

  it("says that version 3 reads a marker, in a board of version 1 or 2, and holds it against the key", () => {
    for (const version of [1, 2]) {
      const doc = version === 1 ? board() : boardV2();
      doc.components = {
        "basou/tools": { lane: "-", note: "scripts", marker: "*.py" },
        basou: { lane: "-", note: "the root", marker: "**" },
        "basou/packages/sdk": { lane: ["saddle"] },
      };
      const told = (where: string) =>
        `${where}: 'marker' is read from board_version 3 on; this file is board_version ${version}`;
      expect(errorsOf(parse(doc))).toEqual([
        told('components["basou/tools"]'),
        told("components.basou"),
        "components.basou.marker: only a directory inside a repo takes a marker, keyed '<repo>/<path in it>'; this key is a repo itself",
      ]);
      // A key no version reads is still unknown.
      doc.components = { "basou/tools": { lane: "-", note: "scripts", markers: "*.py" } };
      expect(errorsOf(parse(doc))).toEqual([`components["basou/tools"]: unknown key 'markers'`]);
    }
  });

  it("says only that an empty key is empty, with a marker or without", () => {
    expect(
      errorsOf(
        parse(
          withComponents({
            "": { lane: ["saddle"], marker: "**" },
            "  ": { lane: ["saddle"], marker: "**" },
          }),
        ),
      ),
    ).toEqual([
      'components[""]: a component key must be a non-empty path',
      'components["  "]: a component key must be a non-empty path',
    ]);
  });

  it("takes a marker on any key with a path after the repo's name, as git would write it or not", () => {
    for (const key of ["basou/x/", "basou//x", "basou/./x", "/x"]) {
      expect(parse(withComponents({ [key]: { lane: ["saddle"], marker: "**" } })).ok, key).toBe(
        true,
      );
    }
  });

  it("says a repo itself takes no marker whatever the marker is, after the note and before the lanes", () => {
    const itself =
      "only a directory inside a repo takes a marker, keyed '<repo>/<path in it>'; this key is a repo itself";
    expect(errorsOf(parse(withComponents({ basou: { lane: ["saddle"], marker: 1 } })))).toEqual([
      "components.basou.marker: Invalid input: expected string, received number",
      `components.basou.marker: ${itself}`,
    ]);
    expect(
      errorsOf(
        parse(
          withComponents({
            basou: { lane: "-", marker: "**" },
            "basou/": { lane: ["nope", "saddle", "saddle"], marker: "**" },
          }),
        ),
      ),
    ).toEqual([
      "components.basou.note: a component with lane '-' needs a note saying why",
      `components.basou.marker: ${itself}`,
      `components["basou/"].marker: ${itself}`,
      `components["basou/"].lane[0]: no lane has the id 'nope'`,
      `components["basou/"].lane[2]: 'saddle' is listed twice`,
    ]);
  });
});

describe("parseBoardDeclaration: what is wrong with a branch", () => {
  const branchOf = (branch: string) =>
    parse(withObserve({ key: "ci", kind: "github_ci", repo: "o/n", workflow: "q.yml", branch }));
  const chars =
    "must be a branch name such as main, using only A-Z, a-z, 0-9, '.', '_', '-' and '/'";

  it("takes a name of those characters that starts with a letter, a digit or '_'", () => {
    for (const branch of ["main", "_x", "a.b/c.d", "release/1.x", "a-b_c", "a/b/c"]) {
      expect(branchOf(branch).ok, branch).toBe(true);
    }
  });

  it("says the first thing wrong with a branch", () => {
    for (const [branch, problem] of [
      ["", chars],
      ["a b", chars],
      ["a~b", chars],
      ["a@{1}", chars],
      [`a${String.fromCharCode(0xe9)}`, chars],
      ["-x", "must not start with '-', '.' or '/'"],
      [".x", "must not start with '-', '.' or '/'"],
      ["/x", "must not start with '-', '.' or '/'"],
      ["..", "must not start with '-', '.' or '/'"],
      ["a..b", "must not hold '..'"],
      ["a/..", "must not hold '..'"],
      ["a//b", "must not hold '//'"],
      ["a//", "must not hold '//'"],
      ["a//.b", "must not hold '//'"],
      ["a/.b", "must not have a part that starts with '.' (after a '/')"],
      ["a/.", "must not have a part that starts with '.' (after a '/')"],
      ["x.", "must not end with '.' or '/'"],
      ["x/", "must not end with '.' or '/'"],
    ] as const) {
      expect(errorsOf(branchOf(branch)), branch).toEqual([`observe[0].branch: ${problem}`]);
    }
  });
});
