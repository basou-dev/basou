import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { type BoardDeclarationResult, parseBoardDeclaration } from "./declaration.js";

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
    expect(errorsOf(parse({ ...board(), board_version: 3, title: "", extra: 1 }))).toEqual([
      "board_version: this basou reads board_version 1 or 2, not 3",
    ]);
  });

  it("refuses a board_version that is missing or not a number", () => {
    const { board_version: _v, ...missing } = board();
    const reads = "board_version: must be a board version this basou reads (1 or 2)";
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

  it("refuses keys that belong to another kind", () => {
    expect(
      errorsOf(
        parse(withMeasure({ id: "a", kind: "trail_count", of: "tasks", repo: ".", unit: "tasks" })),
      ),
    ).toEqual(["measures[0]: unknown key 'repo'"]);
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
    ).toEqual(["measures[0]: unknown key 'pattern'"]);
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
  it.each<[string, (doc: Record<string, unknown>) => void, string]>([
    ["a file_count", (d) => extra(entry(d.measures, 0)), "measures[0]"],
    ["a line_count", (d) => extra(entry(d.measures, 2)), "measures[2]"],
    ["a match_count", (d) => extra(entry(d.measures, 1)), "measures[1]"],
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
  ])("refuses an unknown key in %s", (_what, change, at) => {
    const doc = board();
    change(doc);
    expect(errorsOf(parse(doc))).toEqual([`${at}: unknown key 'extra'`]);
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
    expect(errorsOf(parse(withMeasure(measure)))).toEqual([`${at}: unknown key 'extra'`]);
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
    const plain = stringify({ ...board(), board_version: 3 });
    expect(plain).toContain("title: A board\n");
    const text = plain.replace("title: A board\n", "title: !v3tag A board\n");
    expect(errorsOf(parseBoardDeclaration(text, { manifestRepoPaths: REPOS }))).toEqual([
      "board_version: this basou reads board_version 1 or 2, not 3",
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
      "observe[2]: unknown key 'repo'",
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
    ];
    const workflow = "must be the file name of a workflow, such as quality.yml";
    const branch =
      "must be a branch name such as main, using only A-Z, a-z, 0-9, '.', '_', '-' and '/'";
    expect(errorsOf(parse(doc))).toEqual([
      `observe[0].workflow: ${workflow}`,
      `observe[1].workflow: ${workflow}`,
      `observe[2].workflow: ${workflow}`,
      `observe[3].branch: ${branch}`,
      `observe[4].branch: ${branch}`,
      `observe[5].branch: ${branch}`,
      `observe[6].branch: ${branch}`,
      `observe[8].branch: ${branch}`,
      `observe[9].branch: ${branch}`,
      `observe[10].workflow: ${workflow}`,
      `observe[11].workflow: ${workflow}`,
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
