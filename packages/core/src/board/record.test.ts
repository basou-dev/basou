import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { ulid as monotonicUlid } from "../ids/ulid.js";
import { type BoardDeclaration, parseBoardDeclaration } from "./declaration.js";
import type { BoardMeasurement } from "./measure.js";
import { buildRecord, orderAnomalies, parseRecordInput, writeRecord } from "./record.js";

// Pass-through, so one test can make the next name a record already has.
const forced = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("ulid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ulid")>();
  return {
    ...actual,
    monotonicFactory: (...args: Parameters<typeof actual.monotonicFactory>) => {
      const real = actual.monotonicFactory(...args);
      return (seedTime?: number) => forced.names.shift() ?? real(seedTime);
    },
  };
});
const { decodeTime } = await import("ulid");

// Pass-through so one test can make a write fail after it has begun.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const STAGES = ["01", "02", "03", "04", "05", "06"];

function declaration(): BoardDeclaration {
  const result = parseBoardDeclaration(
    stringify({
      board_version: 1,
      title: "Test board",
      stages: Object.fromEntries(STAGES.map((id) => [id, { meaning: `stage ${id}` }])),
      lanes: [
        { id: "core", name: "Core" },
        { id: "docs", name: "Docs" },
      ],
      components: { "ws/app": { lane: ["core"], note: "the app" } },
      axis: { version: 1, review_due_days: 60 },
      effort: { start: "2026-04-28", time_zone: "UTC" },
    }),
    { manifestRepoPaths: [] },
  );
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.declaration;
}

// A board of version 2 that declares two observations.
function observingDeclaration(): BoardDeclaration {
  const result = parseBoardDeclaration(
    stringify({
      board_version: 2,
      title: "Test board",
      stages: Object.fromEntries(
        STAGES.map((id) => [id, { meaning: `stage ${id}`, look: [`what ${id} needs`] }]),
      ),
      lanes: [
        { id: "core", name: "Core" },
        { id: "docs", name: "Docs" },
      ],
      observe: [
        { key: "npm_cli", kind: "npm_version", package: "@scope/cli" },
        { key: "users", kind: "manual", how: "ask the operator" },
      ],
      axis: { version: 1, review_due_days: 60 },
      effort: { start: "2026-04-28", time_zone: "UTC" },
    }),
    { manifestRepoPaths: [] },
  );
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.declaration;
}

const DIGEST = `sha256:${"a".repeat(64)}`;

function cells(states: Record<string, string[]> = {}) {
  return ["core", "docs"].flatMap((lane) =>
    STAGES.map((stage, i) => ({ lane, stage, state: states[lane]?.[i] ?? "none" })),
  );
}

function input(over: Record<string, unknown> = {}) {
  return {
    measure_digest: DIGEST,
    cells: cells(),
    prose: { summary: "fine" },
    judged_by: { model: "Claude Opus 5.5", self_reported: true },
    ...over,
  };
}

function refused(value: unknown): string[] {
  const result = parseRecordInput(value, declaration());
  if (result.ok) throw new Error("accepted");
  return result.errors;
}

describe("parseRecordInput", () => {
  it("takes a whole input, filling what may be left out", () => {
    const result = parseRecordInput(input(), declaration());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.observed).toEqual({});
    expect(result.input.prose).toEqual({
      summary: "fine",
      lanes: {},
      operator_turns: [],
      footnotes: [],
    });
    expect(result.input.axis_review).toBeNull();
  });

  it("refuses an unknown key anywhere but the names of observations, and says where", () => {
    const value = input({
      extra: 1,
      judged_by: { model: "m", self_reported: true, by: "x" },
      observed: { anything: { value: 1, observed_at: "2026-10-07", source: "s" } },
    });
    (value.cells as Record<string, unknown>[])[0] = { ...cells()[0], note: "x" };
    expect(refused(value)).toEqual([
      "cells[0]: unknown key 'note'",
      "judged_by: unknown key 'by'",
      "(top level): unknown key 'extra'",
    ]);
  });

  it("refuses a digest, state, judge or trigger it does not know", () => {
    const value = input({
      measure_digest: "sha256:xyz",
      judged_by: { model: " ", self_reported: false },
      axis_review: { triggers: ["f"], summary: "s" },
    });
    (value.cells as Record<string, unknown>[])[1] = { lane: "core", stage: "02", state: "maybe" };
    expect(refused(value)).toEqual([
      "measure_digest: must be the digest of a measurement (sha256: and 64 hex digits)",
      "cells[1].state: must be one of done, part, blocked, shelved, none, unverified",
      "judged_by.model: must be a non-empty string",
      "judged_by.self_reported: must be true: basou cannot tell which model judged",
      "axis_review.triggers[0]: must be one of a, b, c, d, e",
    ]);
  });

  it("refuses cells that are not every lane at every stage, once, and a missing reason", () => {
    const list = cells({ core: ["done", "blocked", "shelved", "unverified", "none", "none"] });
    list[2] = { ...list[2], reason: "waiting on x" } as (typeof list)[number];
    list.push({ lane: "core", stage: "01", state: "done" });
    list.push({ lane: "web", stage: "07", state: "none" });
    const value = input({ cells: list.filter((c) => !(c.lane === "docs" && c.stage === "06")) });
    expect(refused(value)).toEqual([
      "cells[1].reason: a cell that is blocked needs a reason",
      "cells[3].reason: a cell that is unverified needs a reason",
      "cells[11]: lane 'core' at stage '01' is given more than once",
      "cells[12].lane: 'web' is not a lane of the board",
      "cells[12].stage: '07' is not a stage (01, 02, 03, 04, 05, 06)",
      "cells: lane 'docs' has no cell at stage '06'",
    ]);
    expect(refused(input({ cells: cells({ docs: ["shelved"] }) }))).toEqual([
      "cells[6].reason: a cell that is shelved needs a reason",
    ]);
  });

  it("holds each part whose shape is right against the board, whatever else is wrong", () => {
    const list = cells({ core: ["blocked"] }).filter(
      (c) => !(c.lane === "docs" && c.stage === "06"),
    );
    const observed = { " ": { value: 1, observed_at: "2026-10-07", source: "s" } };
    expect(
      refused(
        input({ extra: true, observed, cells: list, prose: { summary: "x", lanes: { web: "y" } } }),
      ),
    ).toEqual([
      "(top level): unknown key 'extra'",
      'observed[" "]: is not a name it can have',
      "cells[0].reason: a cell that is blocked needs a reason",
      "cells: lane 'docs' has no cell at stage '06'",
      "prose.lanes.web: is not a lane of the board",
    ]);
    const value = JSON.parse(
      JSON.stringify(input({ cells: cells().slice(1) })).replace(
        '"measure_digest"',
        '"observed":{"__proto__":{"value":1,"observed_at":"2026-10-07","source":"s"}},"measure_digest"',
      ),
    );
    expect(refused(value)).toEqual([
      "observed.__proto__: is not a name it can have",
      "cells: lane 'core' has no cell at stage '01'",
    ]);
    // A part whose shape is wrong is reported once, not held against the board too.
    const broken = cells();
    broken[0] = { lane: "core", stage: "01", state: "maybe" };
    expect(refused(input({ cells: broken }))).toEqual([
      "cells[0].state: must be one of done, part, blocked, shelved, none, unverified",
    ]);
  });

  it("keeps an observation's value as JSON.parse read it, and refuses what is not a JSON value", () => {
    const nested = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;
    const at = '"observed_at":"2026-10-07","source":"s"';
    const observed = JSON.parse(
      `{"a":{"value":{"k":[1,{"__proto__":5}],"__proto__":{"x":1}},${at}},` +
        `"b":{"value":1e400,${at}},"c":{"value":${nested(101)},${at}},` +
        `"d":{"value":${nested(100)},${at}},"e":{${at}}}`,
    );
    expect(refused(input({ observed }))).toEqual([
      "observed.a.value.k[1].__proto__: is not a name it can have",
      "observed.a.value.__proto__: is not a name it can have",
      "observed.b.value: is a number too large to be held",
      `observed.c.value${"[0]".repeat(100)}: nests more than 100 deep`,
      "observed.e.value: must be given (null, with an error, when nothing was observed)",
    ]);
    expect(
      refused(
        input({ observed: { f: { value: [undefined], observed_at: "2026-10-07", source: "s" } } }),
      ),
    ).toEqual(["observed.f.value[0]: is not a JSON value"]);
    const result = parseRecordInput(
      input({
        observed: JSON.parse(
          `{"n":{"value":{"big":123456789012345678901234567890,"list":[1,"x",null,true],"deep":${nested(99)}},${at}}}`,
        ),
      }),
      declaration(),
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.input.observed.n?.value).toEqual({
      big: 1.2345678901234568e29,
      list: [1, "x", null, true],
      // One level under the value: as deep as it may nest.
      deep: JSON.parse(nested(99)),
    });
  });

  it("takes the time of an observation only as a calendar date, or one with a time of day and its offset", () => {
    const takes = (observed_at: string) =>
      parseRecordInput(
        input({ observed: { n: { value: 1, observed_at, source: "s" } } }),
        declaration(),
      ).ok;
    for (const good of [
      "2026-10-07",
      "2026-02-28T00:00Z",
      "2028-02-29T23:59:59.5+09:00",
      "2026-10-07T12:00-23:59",
    ]) {
      expect(takes(good), good).toBe(true);
    }
    for (const bad of [
      "2026-02-31",
      "2026-13-01",
      "2027-02-29",
      "2026-10-07T24:00Z",
      "2026-10-07T23:60Z",
      "2026-10-07T23:59:60Z",
      "2026-10-07T12:00+24:00",
      "2026-10-07T12:00+09:60",
      "2026-10-07T12:00",
      "2026-10-07x",
      "x2026-10-07",
      "2026-10-07T12:00Zjunk",
    ]) {
      expect(takes(bad), bad).toBe(false);
    }
  });

  it("refuses an observation of no value with no error, a bad date, prose of a lane the board lacks and a trigger named twice, at once", () => {
    expect(
      refused(
        input({
          observed: {
            a: { value: null, observed_at: "2026-10-07", source: "s" },
            b: { value: 1, observed_at: "yesterday", source: "s" },
          },
          prose: { summary: "x", lanes: { web: "y" } },
          axis_review: { triggers: ["a", "a"], summary: "s" },
        }),
      ),
    ).toEqual([
      "observed.a.error: a value of null needs an error saying why it was not observed",
      "observed.b.observed_at: must be a calendar date (YYYY-MM-DD), or one with a time of day and its offset",
      "prose.lanes.web: is not a lane of the board",
      "axis_review.triggers: names a trigger more than once",
    ]);
  });

  it("refuses an observation or a lane's prose named __proto__, or with an empty name", () => {
    const value = JSON.parse(
      JSON.stringify(input({ prose: { summary: "x", lanes: { core: "y" } } }))
        .replace(
          '"measure_digest"',
          '"observed":{"__proto__":{"value":1,"observed_at":"2026-10-07","source":"s"}},"measure_digest"',
        )
        .replace('"lanes":{"core":"y"}', '"lanes":{"__proto__":"y"}'),
    );
    expect(refused(value)).toEqual([
      "observed.__proto__: is not a name it can have",
      "prose.lanes.__proto__: is not a name it can have",
    ]);
    expect(
      refused(input({ observed: { " ": { value: 1, observed_at: "2026-10-07", source: "s" } } })),
    ).toEqual(['observed[" "]: is not a name it can have']);
  });
});

describe("parseRecordInput: a board that declares what to observe", () => {
  const at = "2026-10-08T10:00:00+09:00";
  const made = { value: "1.0.0", observed_at: at, source: "npm view @scope/cli version" };
  const notMade = { value: null, observed_at: at, source: "the operator", error: "not asked" };

  it("takes exactly the observations the board declares, one not made as null with its error", () => {
    const result = parseRecordInput(
      input({ observed: { npm_cli: made, users: notMade } }),
      observingDeclaration(),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an observation the board declares but the input leaves out, and one it does not declare", () => {
    const result = parseRecordInput(
      input({ observed: { npm_cli: made, npm_cil: made } }),
      observingDeclaration(),
    );
    expect(result.ok ? [] : result.errors).toEqual([
      "observed.users: the board declares it, so it must be given (null, with an error, when it was not observed)",
      "observed.npm_cil: is not an observation the board declares",
    ]);
  });

  it("refuses every declared observation when observed is left out", () => {
    const result = parseRecordInput(input(), observingDeclaration());
    expect(result.ok ? [] : result.errors).toEqual([
      "observed.npm_cli: the board declares it, so it must be given (null, with an error, when it was not observed)",
      "observed.users: the board declares it, so it must be given (null, with an error, when it was not observed)",
    ]);
  });

  it("does not name an observation twice when its name is empty or __proto__", () => {
    const value = JSON.parse(
      `{"measure_digest":"${DIGEST}","cells":${JSON.stringify(cells())},"prose":{"summary":"x"},"judged_by":{"model":"m","self_reported":true},"observed":{"npm_cli":${JSON.stringify(made)},"users":${JSON.stringify(notMade)},"__proto__":${JSON.stringify(made)},"":${JSON.stringify(made)}}}`,
    );
    const result = parseRecordInput(value, observingDeclaration());
    expect(result.ok ? [] : result.errors).toEqual([
      "observed.__proto__: is not a name it can have",
      'observed[""]: is not a name it can have',
    ]);
  });

  it("reports only that the input is not an object when it is not one", () => {
    for (const value of ["x", null, []]) {
      const result = parseRecordInput(value, observingDeclaration());
      expect(result.ok ? [] : result.errors).toHaveLength(1);
    }
  });

  it("leaves the names free on a board that declares nothing to observe", () => {
    const result = parseRecordInput(input({ observed: { anything: made } }), declaration());
    expect(result.ok).toBe(true);
  });

  it("keeps the observations and the stages' look in the record of a version 2 board", () => {
    const parsed = parseRecordInput(
      input({ observed: { npm_cli: made, users: notMade } }),
      observingDeclaration(),
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const r = buildRecord({
      declaration: observingDeclaration(),
      measurement: { digest: DIGEST } as BoardMeasurement,
      recordInput: parsed.input,
      recordedAt: new Date("2026-10-08T00:00:00.000Z"),
      recordedWith: { basou: "0.0.0-test", build: null },
    });
    expect(r.record_version).toBe(3);
    expect(r.declaration.observe).toEqual([
      { key: "npm_cli", kind: "npm_version", package: "@scope/cli" },
      { key: "users", kind: "manual", how: "ask the operator" },
    ]);
    expect(r.declaration.stages["04"]).toEqual({ meaning: "stage 04", look: ["what 04 needs"] });
    expect(r.observed).toEqual({ npm_cli: made, users: notMade });
  });
});

describe("buildRecord: a board of version 3 that observes over http", () => {
  const url = "https://example.com/shop/item-1";
  const httpDeclaration = (): BoardDeclaration => {
    const result = parseBoardDeclaration(
      stringify({
        board_version: 3,
        title: "Test board",
        stages: Object.fromEntries(STAGES.map((id) => [id, { meaning: `stage ${id}` }])),
        lanes: [
          { id: "core", name: "Core" },
          { id: "docs", name: "Docs" },
        ],
        observe: [
          {
            key: "shop",
            kind: "http",
            url,
            words: ["in stock", "sold out"],
            count_pattern: "<loc>",
            capture_pattern: "Version ([0-9.]+)",
          },
          { key: "gone", kind: "http", url, words: ["x"] },
        ],
        axis: { version: 1, review_due_days: 60 },
        effort: { start: "2026-04-28", time_zone: "UTC" },
      }),
      { manifestRepoPaths: [] },
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    return result.declaration;
  };

  it("takes the value of a GET as given, and keeps the observation as declared in a record of version 3", () => {
    const at = "2026-10-17T00:00:00Z";
    const observed = {
      shop: {
        value: {
          status: 200,
          redirects: 1,
          final_url: `${url}/`,
          words: [true, false],
          count: 42,
          capture: "2.3",
        },
        observed_at: at,
        source: url,
      },
      // Not 2xx: the status is the value, and what the body would give is null.
      gone: {
        value: { status: 404, redirects: 0, final_url: url, words: null },
        observed_at: at,
        source: url,
      },
    };
    const parsed = parseRecordInput(input({ observed }), httpDeclaration());
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const r = buildRecord({
      declaration: httpDeclaration(),
      measurement: { digest: DIGEST } as BoardMeasurement,
      recordInput: parsed.input,
      recordedAt: new Date("2026-10-17T00:00:00.000Z"),
      recordedWith: { basou: "0.0.0-test", build: null },
    });
    expect(r.record_version).toBe(3);
    expect(r.declaration.observe).toEqual(httpDeclaration().observe);
    expect(r.observed).toEqual(observed);
  });
});

describe("parseRecordInput: the value of each kind of observation", () => {
  const url = "https://example.com/shop/item-1";
  const at = "2026-10-20T00:00:00Z";
  const kinds = (): BoardDeclaration => {
    const result = parseBoardDeclaration(
      stringify({
        board_version: 3,
        title: "Test board",
        stages: Object.fromEntries(STAGES.map((id) => [id, { meaning: `stage ${id}` }])),
        lanes: [
          { id: "core", name: "Core" },
          { id: "docs", name: "Docs" },
        ],
        observe: [
          { key: "npm", kind: "npm_version", package: "@scope/cli" },
          { key: "release", kind: "github_release", repo: "owner/name" },
          { key: "issues", kind: "github_open_issues", repo: "owner/name" },
          { key: "prs", kind: "github_open_prs", repo: "owner/name" },
          { key: "ci", kind: "github_ci", repo: "owner/name", workflow: "ci.yml" },
          { key: "check", kind: "github_check", repo: "owner/name", check: "build" },
          { key: "page", kind: "page_version", url },
          {
            key: "site.shop",
            kind: "http",
            url,
            words: ["in stock", "sold out"],
            count_pattern: "<loc>",
            capture_pattern: "Version ([0-9.]+)",
          },
          { key: "bare", kind: "http", url },
          { key: "users", kind: "manual", how: "ask the operator" },
        ],
        axis: { version: 1, review_due_days: 60 },
        effort: { start: "2026-04-28", time_zone: "UTC" },
      }),
      { manifestRepoPaths: [] },
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    return result.declaration;
  };
  const shopRead = {
    status: 200,
    redirects: 1,
    final_url: `${url}/`,
    words: [true, false],
    count: 42,
    capture: "2.3",
  };
  const good: Record<string, unknown> = {
    npm: "1.2.3",
    release: "v1.2.3",
    issues: 0,
    prs: 12,
    ci: "success",
    check: "in_progress",
    page: "v1.2.3",
    "site.shop": shopRead,
    bare: { status: 404, redirects: 0, final_url: "http://example.com/x" },
    users: { anything: ["the operator", 1, null] },
  };
  const observedOf = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries({ ...good, ...values }).map(([key, value]) => [
        key,
        value === null
          ? { value, observed_at: at, source: "s", error: "not made" }
          : { value, observed_at: at, source: "s" },
      ]),
    );
  const errorsOf = (values: Record<string, unknown>) => {
    const result = parseRecordInput(input({ observed: observedOf(values) }), kinds());
    return result.ok ? [] : result.errors;
  };

  it("takes a value of each kind in its shape, a null with its error of any kind, and any answer of a manual one", () => {
    expect(errorsOf({})).toEqual([]);
    expect(errorsOf(Object.fromEntries(Object.keys(good).map((key) => [key, null])))).toEqual([]);
    // Not 2xx: the body is not read, and what it would give is null.
    expect(
      errorsOf({
        "site.shop": {
          status: 503,
          redirects: 2,
          final_url: url,
          words: null,
          count: null,
          capture: null,
        },
      }),
    ).toEqual([]);
    // 2xx with nothing captured, a count of 0, a captured value with spaces kept.
    expect(errorsOf({ "site.shop": { ...shopRead, count: 0, capture: null } })).toEqual([]);
    expect(errorsOf({ "site.shop": { ...shopRead, capture: " 2.3 " } })).toEqual([]);
    expect(errorsOf({ users: "anything" })).toEqual([]);
  });

  it("refuses a string of a kind that is a number, empty, or carries a line break or spaces at an end", () => {
    expect(
      errorsOf({ npm: "1.2.3\n", release: "", ci: " success", check: 1, page: "v1\u0007" }),
    ).toEqual(
      [
        `observed.release.value: must be a non-empty string with no space or line break at either end and no control or hidden character (kind 'github_release'), received ""`,
        `observed.ci.value: must be a non-empty string with no space or line break at either end and no control or hidden character (kind 'github_ci'), received " success"`,
        "observed.check.value: must be a non-empty string with no space or line break at either end and no control or hidden character (kind 'github_check'), received 1",
        `observed.page.value: must be a non-empty string with no space or line break at either end and no control or hidden character (kind 'page_version'), received "v1\\u0007"`,
        `observed.npm.value: must be a non-empty string with no space or line break at either end and no control or hidden character (kind 'npm_version'), received "1.2.3\\n"`,
      ].sort((a, b) => order(a) - order(b)),
    );
  });

  it("refuses a count that is a string, negative, not whole, or past the integers a number holds exactly", () => {
    for (const value of ["12", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(errorsOf({ issues: value })).toEqual([
        `observed.issues.value: must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER} (kind 'github_open_issues'), received ${JSON.stringify(value)}`,
      ]);
    }
  });

  it("refuses an http status that is not a response's, a string, too many redirects and a URL that is not absolute", () => {
    expect(errorsOf({ bare: { status: "200", redirects: 11, final_url: "/item" } })).toEqual([
      'observed.bare.value.status: must be a whole number from 100 to 599, the status of a response, received "200"',
      "observed.bare.value.redirects: must be a whole number from 0 to 10, received 11",
      'observed.bare.value.final_url: must be an absolute http or https URL with no user, query, fragment or hidden character, received "/item"',
    ]);
    for (const status of [0, 99, 600, 200.5]) {
      expect(errorsOf({ bare: { status, redirects: 0, final_url: url } })).toEqual([
        `observed.bare.value.status: must be a whole number from 100 to 599, the status of a response, received ${status}`,
      ]);
    }
    for (const finalUrl of ["ftp://example.com/", "https://", `${url} x`, "example.com/x"]) {
      expect(errorsOf({ bare: { status: 200, redirects: 0, final_url: finalUrl } })).toHaveLength(
        1,
      );
    }
  });

  it("refuses an http value with a key it does not declare a read of, one left out, and one unknown", () => {
    expect(
      errorsOf({
        bare: { status: 200, redirects: 0, final_url: url, words: [true], body: "x" },
        "site.shop": { status: 200, redirects: 0, final_url: url },
      }),
    ).toEqual(
      [
        'observed["site.shop"].value.words: must be given: the observation declares words (null when the status is not 2xx)',
        'observed["site.shop"].value.count: must be given: the observation declares a count_pattern (null when the status is not 2xx)',
        'observed["site.shop"].value.capture: must be given: the observation declares a capture_pattern (null when the status is not 2xx)',
        "observed.bare.value.words: is not a key of this observation's value (it takes status, redirects, final_url)",
        "observed.bare.value.body: is not a key of this observation's value (it takes status, redirects, final_url)",
      ].sort((a, b) => order(a) - order(b)),
    );
    expect(errorsOf({ bare: "200 0 https://example.com/" })).toEqual([
      "observed.bare.value: must be an object of status, redirects, final_url (kind 'http'), received \"200 0 https://example.com/\"",
    ]);
  });

  it("refuses what the body gives in a shape of its own: a list of another length, a count as a string, and any read of a body not 2xx", () => {
    expect(
      errorsOf({ "site.shop": { ...shopRead, words: [true], count: "42", capture: 2.3 } }),
    ).toEqual([
      'observed["site.shop"].value.words: must be a list of 2 true or false, one for each word declared, in its order, received [true]',
      `observed["site.shop"].value.count: must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER} (0 when nothing matches), received "42"`,
      'observed["site.shop"].value.capture: must be a string, or null when nothing matches, received 2.3',
    ]);
    expect(
      errorsOf({
        "site.shop": { ...shopRead, status: 404, words: [null, null], count: 0, capture: null },
      }),
    ).toEqual([
      'observed["site.shop"].value.words: must be null: the status 404 is not 2xx, so the body is not read, received [null,null]',
      'observed["site.shop"].value.count: must be null: the status 404 is not 2xx, so the body is not read, received 0',
    ]);
    // With a status that is no status, either shape of a read is let through.
    expect(
      errorsOf({ "site.shop": { ...shopRead, status: "200", words: null, count: null } }),
    ).toEqual([
      'observed["site.shop"].value.status: must be a whole number from 100 to 599, the status of a response, received "200"',
    ]);
  });

  it("refuses a string of a kind with a control or a hidden character anywhere, or a space at its end, and keeps a capture as it is", () => {
    const refusedWith = (value: string) =>
      errorsOf({ release: value }).map((e) => e.slice(0, e.indexOf(" (kind")));
    const refusal =
      "observed.release.value: must be a non-empty string with no space or line break at either end and no control or hidden character";
    for (const value of [
      "v1\u001fx",
      "v1\u007f",
      "v1\u0085x",
      "v1\u009f",
      "1.2.3 ",
      "v1\u200bx",
      "v1\u202ex",
      "v1\u2028x",
      "\ufeffv1",
      "v1\u2060x",
      "v1\u061cx",
    ]) {
      expect(refusedWith(value), JSON.stringify(value)).toEqual([refusal]);
    }
    expect(errorsOf({ release: "v1 x" })).toEqual([]);
    expect(errorsOf({ "site.shop": { ...shopRead, capture: "\u200b2.3\u2028" } })).toEqual([]);
  });

  it("refuses a read of a 2xx body that is null or of another shape, and any read of a body not 2xx, at the edges of 2xx", () => {
    expect(errorsOf({ "site.shop": { ...shopRead, words: [true, "false"], count: null } })).toEqual(
      [
        'observed["site.shop"].value.words: must be a list of 2 true or false, one for each word declared, in its order, received [true,"false"]',
        `observed["site.shop"].value.count: must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER} (0 when nothing matches), received null`,
      ],
    );
    expect(errorsOf({ "site.shop": { ...shopRead, words: null } })).toEqual([
      'observed["site.shop"].value.words: must be a list of 2 true or false, one for each word declared, in its order, received null',
    ]);
    for (const count of [-1, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
      expect(errorsOf({ "site.shop": { ...shopRead, count } })).toHaveLength(1);
    }
    expect(errorsOf({ "site.shop": { ...shopRead, count: Number.MAX_SAFE_INTEGER } })).toEqual([]);
    // 299 is 2xx; 300 and 101 are not.
    expect(errorsOf({ "site.shop": { ...shopRead, status: 299 } })).toEqual([]);
    const notRead = { words: null, count: null, capture: null };
    for (const status of [300, 101, 599, 100]) {
      expect(errorsOf({ "site.shop": { ...shopRead, ...notRead, status } })).toEqual([]);
      expect(
        errorsOf({ "site.shop": { ...shopRead, ...notRead, status, capture: "2.3" } }),
      ).toEqual([
        `observed["site.shop"].value.capture: must be null: the status ${status} is not 2xx, so the body is not read, received "2.3"`,
      ]);
    }
    expect(errorsOf({ "site.shop": { ...shopRead, status: 200, ...notRead } })).toHaveLength(2);
  });

  it("refuses a final_url with a user, a password, a query or a fragment, and takes a port and an escaped '?' in the path", () => {
    const finalUrlOf = (finalUrl: string) =>
      errorsOf({ bare: { status: 200, redirects: 0, final_url: finalUrl } });
    for (const finalUrl of [
      "https://example.com/login?token=abc",
      "https://example.com/login?",
      "https://example.com/page#top",
      "https://example.com/#",
      "https://user@example.com/",
      "https://user:secret@example.com/",
      "https://:secret@example.com/",
    ]) {
      expect(finalUrlOf(finalUrl), finalUrl).toEqual([
        `observed.bare.value.final_url: must be an absolute http or https URL with no user, query, fragment or hidden character, received ${JSON.stringify(finalUrl)}`,
      ]);
    }
    for (const finalUrl of [
      "https://example.com:8443/a/b",
      "http://127.0.0.1:4400/login",
      "https://example.com/a%3Fb%23c",
    ]) {
      expect(finalUrlOf(finalUrl), finalUrl).toEqual([]);
    }
    // A character a terminal hides, which no URL the guide's command prints holds.
    for (const code of [0x200b, 0x202e, 0x2028, 0xfeff]) {
      const finalUrl = `https://example.com/a${String.fromCodePoint(code)}b`;
      const errors = finalUrlOf(finalUrl);
      expect(errors, code.toString(16)).toHaveLength(1);
      expect(errors[0]).toContain(
        "observed.bare.value.final_url: must be an absolute http or https URL with no user, query, fragment or hidden character, received",
      );
    }
    // A null with its error is taken as before, and so is any answer of a manual one.
    expect(errorsOf({ bare: null, users: "https://user@example.com/?q#f" })).toEqual([]);
  });

  it("refuses negative redirects, and a URL with no // or a control in it, but takes a scheme in capitals", () => {
    expect(errorsOf({ bare: { status: 200, redirects: -1, final_url: url } })).toEqual([
      "observed.bare.value.redirects: must be a whole number from 0 to 10, received -1",
    ]);
    expect(errorsOf({ bare: { status: 200, redirects: 10, final_url: url } })).toEqual([]);
    for (const finalUrl of [
      "https:example.com/x",
      "https://example.com/\u0001",
      "https://e\u0085.com/",
    ]) {
      expect(
        errorsOf({ bare: { status: 200, redirects: 0, final_url: finalUrl } }),
        JSON.stringify(finalUrl),
      ).toHaveLength(1);
    }
    expect(
      errorsOf({ bare: { status: 200, redirects: 0, final_url: "HTTPS://example.com/" } }),
    ).toEqual([]);
  });

  it("refuses a value nested too deep as before, and does not hold it against its kind", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20000; i++) deep = [deep];
    const errors = errorsOf({
      release: deep,
      bare: { status: deep, redirects: 0, final_url: url },
    });
    expect(errors).toEqual([
      expect.stringMatching(/^observed\.release\.value(\[0\])+: nests more than 100 deep$/),
      expect.stringMatching(/^observed\.bare\.value\.status(\[0\])+: nests more than 100 deep$/),
    ]);
  });

  it("shows what it received with what a terminal hides escaped, cut where an escape ends", () => {
    expect(errorsOf({ release: "\ufeffv1" })).toEqual([
      `observed.release.value: must be a non-empty string with no space or line break at either end and no control or hidden character (kind 'github_release'), received "\\ufeffv1"`,
    ]);
    // Each \n of the JSON is one of its 60: the cut never splits one.
    const [error] = errorsOf({ release: `${"x".repeat(58)}\n\n` });
    expect(error?.endsWith(`received "${"x".repeat(58)}\\n...`)).toBe(true);
    const [astral] = errorsOf({ release: ` ${"\u{1F600}".repeat(80)}` });
    expect(astral?.endsWith(`received " ${"\u{1F600}".repeat(58)}...`)).toBe(true);
  });

  it("shows what it received cut short, with nothing that acts on a terminal", () => {
    // Refused for the space it starts with; shown with the override escaped.
    const [error] = errorsOf({ npm: ` \u202e${"x".repeat(100)}` });
    expect(error).toBe(
      `observed.npm.value: must be a non-empty string with no space or line break at either end and no control or hidden character (kind 'npm_version'), received " \\u202e${"x".repeat(57)}...`,
    );
  });
});

// The place of an error among the observations, in the order the board declares them.
function order(error: string): number {
  const keys = [
    "npm",
    "release",
    "issues",
    "prs",
    "ci",
    "check",
    "page",
    '"site.shop"',
    "bare",
    "users",
  ];
  return keys.findIndex(
    (key) => error.startsWith(`observed.${key}.`) || error.startsWith(`observed[${key}]`),
  );
}

describe("buildRecord: a board of version 3 that observes a check run, with notes", () => {
  it("keeps the check run and each observation's notes as declared, and the value as given", () => {
    const observe = [
      {
        key: "deploy",
        kind: "github_check",
        repo: "owner/name",
        check: "Workers Builds: app",
        branch: "main",
        notes: ["a commit that changes only docs starts no build"],
      },
      { key: "users", kind: "manual", how: "ask", notes: ["ask on Mondays"] },
    ];
    const result = parseBoardDeclaration(
      stringify({
        board_version: 3,
        title: "Test board",
        stages: Object.fromEntries(STAGES.map((id) => [id, { meaning: `stage ${id}` }])),
        lanes: [
          { id: "core", name: "Core" },
          { id: "docs", name: "Docs" },
        ],
        observe,
        axis: { version: 1, review_due_days: 60 },
        effort: { start: "2026-04-28", time_zone: "UTC" },
      }),
      { manifestRepoPaths: [] },
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const at = "2026-10-17T00:00:00Z";
    const observed = {
      deploy: { value: "success", observed_at: at, source: "gh api" },
      users: { value: 12, observed_at: at, source: "the operator" },
    };
    const parsed = parseRecordInput(input({ observed }), result.declaration);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const r = buildRecord({
      declaration: result.declaration,
      measurement: { digest: DIGEST } as BoardMeasurement,
      recordInput: parsed.input,
      recordedAt: new Date("2026-10-17T00:00:00.000Z"),
      recordedWith: { basou: "0.0.0-test", build: null },
    });
    expect(r.record_version).toBe(3);
    expect(r.declaration.observe).toEqual(observe);
    expect(r.observed).toEqual(observed);
  });
});

describe("orderAnomalies", () => {
  it("finds a stage not started, blocked or shelved before one done or begun, not counting unverified", () => {
    const parsed = parseRecordInput(
      input({
        cells: cells({
          core: ["done", "none", "unverified", "part", "blocked", "done"],
          docs: ["shelved", "unverified", "part", "none", "none", "none"],
        }).map((c) =>
          c.state === "blocked" || c.state === "shelved" || c.state === "unverified"
            ? { ...c, reason: "r" }
            : c,
        ),
      }),
      declaration(),
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(orderAnomalies(parsed.input, declaration())).toEqual([
      { lane: "core", stage: "02", state: "none", before: "04" },
      { lane: "core", stage: "05", state: "blocked", before: "06" },
      { lane: "docs", stage: "01", state: "shelved", before: "03" },
    ]);
  });
});

describe("buildRecord and writeRecord", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-board-record-"));
  });
  afterEach(async () => {
    forced.names.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  function record() {
    const parsed = parseRecordInput(input(), declaration());
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    return buildRecord({
      declaration: declaration(),
      measurement: { digest: DIGEST } as BoardMeasurement,
      recordInput: parsed.input,
      recordedAt: new Date("2026-10-07T00:00:00.000Z"),
      recordedWith: { basou: "0.0.0-test", build: null },
    });
  }

  it("keeps the declaration as parsed, the measurement and the input, and writes it whole under a ULID", async () => {
    const r = record();
    expect(Object.keys(r)).toEqual([
      "record_version",
      "recorded_at",
      "recorded_with",
      "declaration",
      "measure",
      "observed",
      "cells",
      "prose",
      "judged_by",
      "axis_review",
      "order_anomalies",
    ]);
    const d = declaration();
    expect(r.declaration).toEqual({
      title: d.title,
      stages: d.stages,
      lanes: d.lanes,
      measures: [],
      ratios: [],
      components: { "ws/app": { lane: ["core"], note: "the app" } },
      axis: d.axis,
      effort: { start: "2026-04-28", time_zone: "UTC" },
      observe: [],
    });
    expect(r.record_version).toBe(3);
    expect(r.recorded_at).toBe("2026-10-07T00:00:00.000Z");
    const records = join(dir, "records");
    const name = await writeRecord(records, r);
    expect(name).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/);
    expect(await readdir(records)).toEqual([name]);
    expect(JSON.parse(await readFile(join(records, name), "utf8"))).toEqual(r);
  });

  it("names a record by a ULID whose time is its recorded_at, not the time it is written", async () => {
    // basou's own ULIDs come from a monotonic factory, which, once it has given
    // out a later time, gives that time again for an earlier one.
    const later = monotonicUlid();
    expect(decodeTime(later)).toBeGreaterThan(Date.parse("2026-10-07T00:00:00.000Z"));
    const name = await writeRecord(join(dir, "records"), record());
    expect(new Date(decodeTime(name.replace(/\.json$/, ""))).toISOString()).toBe(
      "2026-10-07T00:00:00.000Z",
    );
  });

  it("does not keep the measurement's diff, which the previous record derives", () => {
    const parsed = parseRecordInput(input(), declaration());
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const r = buildRecord({
      declaration: declaration(),
      measurement: { digest: DIGEST, diff: { against: "X" } } as unknown as BoardMeasurement,
      recordInput: parsed.input,
      recordedAt: new Date("2026-10-07T00:00:00.000Z"),
      recordedWith: { basou: "0.0.0-test", build: null },
    });
    expect(r.measure).toEqual({ digest: DIGEST });
  });

  it("tries another name rather than replace a record, and leaves no other file", async () => {
    const records = join(dir, "records");
    const first = await writeRecord(records, record());
    forced.names.push(first.replace(/\.json$/, ""));
    const second = await writeRecord(records, record());
    expect(second).not.toBe(first);
    expect(forced.names).toEqual([]);
    expect(new Date(decodeTime(second.replace(/\.json$/, ""))).toISOString()).toBe(
      "2026-10-07T00:00:00.000Z",
    );
    expect((await readdir(records)).sort()).toEqual([first, second].sort());
  });

  it("names records with the same recorded_at in the order they are written", async () => {
    const records = join(dir, "records");
    const names: string[] = [];
    for (let i = 0; i < 10; i++) names.push(await writeRecord(records, record()));
    expect([...names].sort()).toEqual(names);
  });

  it("refuses a records path that is not a directory, a link to one included, and writes nothing", async () => {
    const records = join(dir, "records");
    await writeFile(records, "not a directory\n");
    await expect(writeRecord(records, record())).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["records"]);
    await rm(records);
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, records);
    await expect(writeRecord(records, record())).rejects.toThrow(
      "the records directory is not a directory",
    );
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("leaves nothing behind when a write fails part of the way, not even a records directory it made", async () => {
    const failing = async (path: Parameters<typeof actualFs.writeFile>[0]) => {
      await actualFs.writeFile(path, "{ part of a record", { flag: "wx" });
      throw Object.assign(new Error("file too large"), { code: "EFBIG" });
    };
    const records = join(dir, "records");
    vi.mocked(writeFile).mockImplementationOnce(failing);
    await expect(writeRecord(records, record())).rejects.toThrow("file too large");
    expect(await readdir(dir)).toEqual([]);
    const first = await writeRecord(records, record());
    vi.mocked(writeFile).mockImplementationOnce(failing);
    await expect(writeRecord(records, record())).rejects.toThrow("file too large");
    expect(await readdir(records)).toEqual([first]);
  });
});
