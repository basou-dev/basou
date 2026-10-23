import { describe, expect, it } from "vitest";
import { diffCells, diffDeclarations, diffMeasurements, diffObserved, setEntryOf } from "./diff.js";

// A measurement cut down to the parts a diff looks at, and some it does not.
function measurement(over: Record<string, unknown> = {}) {
  return {
    board_version: 1,
    title: "Board",
    measured_at: "2026-10-06T00:00:00.000Z",
    measured_with: { basou: "0.64.0", build: "aaaaaaa" },
    complete: true,
    not_found: [],
    digest: "sha256:old",
    methods: { repos: 1, components: 2 },
    repos: [
      { path: ".", name: "ws", commits: 10, files: 4 },
      { path: "../basou", name: "basou", commits: 100, files: 40 },
    ],
    measures: { md: { value: 2, unit: "files" } },
    ratios: { r: { value: 0.5, numerator: "a", denominator: "b" } },
    trail: { decisions_all: 5, tracks_open: [{ id: "decision_A", title: "Track A" }] },
    freshness: { newest_session_at: "2026-10-05T00:00:00Z" },
    effort: { elapsed_days: 3, active_ms: { union: 1000 }, daily: [{ date: "2026-10-05" }] },
    components: {
      found: { ws: { kinds: ["manifest"], status: "known" } },
      unacknowledged: ["ws/x"],
      gone: [],
      kind_changed: null,
    },
    axis: { review_needed: false },
    ...over,
  };
}

describe("setEntryOf: a name that came into or went out of a set", () => {
  it("reads the list and the name of each place a set's name is compared at", () => {
    const sets = diffMeasurements(
      measurement({
        measures: { "m.paths": { value: ['db/"q".sql'], unit: "files" } },
        components: { found: {}, unacknowledged: ["ws/x"], gone: ["ws/old"], kind_changed: null },
      }),
      measurement({
        measures: { "m.paths": { value: [], unit: "files" } },
        components: { found: {}, unacknowledged: [], gone: [], kind_changed: null },
      }),
      "01M4",
    );
    expect(sets.removed.map((r) => setEntryOf(r.at))).toEqual([
      { list: 'measures["m.paths"].value', name: 'db/"q".sql' },
      { list: "components.unacknowledged", name: "ws/x" },
      { list: "components.gone", name: "ws/old" },
    ]);
    expect(setEntryOf('measures.mig.value["db/a.sql"]')).toEqual({
      list: "measures.mig.value",
      name: "db/a.sql",
    });
  });

  it("is null for every other place, a keyed list's entry among them", () => {
    for (const at of [
      'repos["../app"].commits',
      'repos["../app"]',
      "measures.mig.value",
      'trail.tracks_open["decision_A"]',
      'trail.tracks_open["decision_A"].title',
      'not_found["measures.md"]',
      'components.found["ws"].kinds',
      'components.gone["unclosed]',
    ]) {
      expect(setEntryOf(at)).toBeNull();
    }
  });
});

describe("diffMeasurements: the paths of a file_paths measure", () => {
  const withPaths = (value: unknown, unit = "files") =>
    measurement({ measures: { md: { value: 2, unit: "files" }, mig: { value, unit } } });

  it("lists each path that came in and went out when both hold a list, and nothing for the same set", () => {
    const paths = ["db/a.sql", "db/b.sql", 'db/"q".sql'];
    const before = withPaths(paths);
    const after = withPaths(["db/b.sql", "db/c.sql", 'db/"q".sql']);
    expect(diffMeasurements(before, after, "01M4")).toEqual({
      against: "01M4",
      values: [],
      methods: [],
      added: [{ at: 'measures.mig.value["db/c.sql"]', value: true }],
      removed: [{ at: 'measures.mig.value["db/a.sql"]', value: true }],
    });
    expect(diffMeasurements(before, withPaths([...paths].reverse()), "01M4")).toEqual({
      against: "01M4",
      values: [],
      methods: [],
      added: [],
      removed: [],
    });
    // The rest of the measure is compared as before.
    expect(diffMeasurements(withPaths([]), withPaths(["db/a.sql"], "paths"), "01M4")).toMatchObject(
      {
        values: [{ at: "measures.mig.unit", before: "files", after: "paths" }],
        added: [{ at: 'measures.mig.value["db/a.sql"]', value: true }],
        removed: [],
      },
    );
  });

  it("compares the value whole when one of the two is not a list", () => {
    expect(diffMeasurements(withPaths(null), withPaths(["db/a.sql"]), "01M4").values).toEqual([
      { at: "measures.mig.value", before: null, after: ["db/a.sql"] },
    ]);
    expect(diffMeasurements(withPaths(["db/a.sql"]), withPaths(null), "01M4").values).toEqual([
      { at: "measures.mig.value", before: ["db/a.sql"], after: null },
    ]);
    expect(diffMeasurements(withPaths("a.sql"), withPaths(["db/a.sql"]), "01M4").values).toEqual([
      { at: "measures.mig.value", before: "a.sql", after: ["db/a.sql"] },
    ]);
    const only = diffMeasurements(measurement(), withPaths(["db/a.sql"]), "01M4");
    expect(only.added).toEqual([
      { at: "measures.mig.value", value: ["db/a.sql"] },
      { at: "measures.mig.unit", value: "files" },
    ]);
  });

  it("names a measure whose id is not a plain word with its id quoted", () => {
    const at = (value: unknown) =>
      measurement({ measures: { "site.pages": { value, unit: "files" } } });
    expect(diffMeasurements(at(["a"]), at(["b"]), "01M4")).toMatchObject({
      added: [{ at: 'measures["site.pages"].value["b"]', value: true }],
      removed: [{ at: 'measures["site.pages"].value["a"]', value: true }],
    });
  });
});

describe("diffMeasurements", () => {
  it("finds nothing moved between two measurements of the same values, whenever and however measured", () => {
    const after = measurement({
      measured_at: "2026-10-07T00:00:00.000Z",
      measured_with: { basou: "0.65.0", build: "bbbbbbb" },
      digest: "sha256:new",
      freshness: { newest_session_at: "2026-10-07T00:00:00Z" },
      effort: { elapsed_days: 4, active_ms: { union: 1000 }, daily: [{ date: "2026-10-06" }] },
      axis: { review_needed: true },
      components: {
        found: { ws: { kinds: ["manifest"], status: "known" } },
        unacknowledged: ["ws/x"],
        gone: [],
        kind_changed: [{ key: "ws", before: [], after: ["manifest"] }],
      },
      diff: { against: "X" },
    });
    expect(diffMeasurements(measurement(), after, "01M4")).toEqual({
      against: "01M4",
      values: [],
      methods: [],
      added: [],
      removed: [],
    });
  });

  it("names each value that moved by where it is, with the change of a number", () => {
    const after = measurement({
      complete: false,
      repos: [
        { path: "../basou", name: "basou", commits: 103, files: 40 },
        { path: ".", name: "ws", commits: 10, files: 4 },
      ],
      measures: { md: { value: 3, unit: "files" } },
      ratios: { r: { value: 0.25, numerator: "a", denominator: "b" } },
      title: "Board, renamed",
    });
    expect(diffMeasurements(measurement(), after, "01M4").values).toEqual([
      { at: "title", before: "Board", after: "Board, renamed" },
      { at: "complete", before: true, after: false },
      { at: 'repos["../basou"].commits', before: 100, after: 103, delta: 3 },
      { at: "measures.md.value", before: 2, after: 3, delta: 1 },
      { at: "ratios.r.value", before: 0.5, after: 0.25, delta: -0.25 },
    ]);
  });

  it("does not compare when a repo was last fetched, as the digest does not hold it", () => {
    const repo = { path: ".", base: "origin/main", behind: 0, ahead: 1 };
    const before = measurement({
      repos: [{ ...repo, fetched_at: "2026-10-05T00:00:00.000Z" }],
    });
    const after = measurement({
      repos: [{ ...repo, behind: 2, fetched_at: "2026-10-06T00:00:00.000Z" }],
    });
    expect(diffMeasurements(before, after, "01M4")).toMatchObject({
      values: [{ at: 'repos["."].behind', before: 0, after: 2, delta: 2 }],
      added: [],
      removed: [],
    });
    const unfetched = measurement({ repos: [{ ...repo, fetched_at: null }] });
    expect(diffMeasurements(before, unfetched, "01M4").values).toEqual([]);
  });

  it("shows behind_main gone and the base, behind and ahead come, once, against a record of version 1 or 2", () => {
    const before = measurement({ repos: [{ path: ".", behind_main: 2 }] });
    const after = measurement({
      repos: [
        {
          path: ".",
          base: "origin/main",
          behind: 2,
          ahead: 0,
          fetched_at: "2026-10-06T00:00:00.000Z",
        },
      ],
    });
    expect(diffMeasurements(before, after, "01M4")).toMatchObject({
      values: [],
      added: [
        { at: 'repos["."].base', value: "origin/main" },
        { at: 'repos["."].behind', value: 2 },
        { at: 'repos["."].ahead', value: 0 },
      ],
      removed: [{ at: 'repos["."].behind_main', value: 2 }],
    });
  });

  it("tells entries apart by what names them, and compares lists of names as sets", () => {
    const after = measurement({
      not_found: [{ at: "measures.md", reason: "gone" }],
      repos: [{ path: ".", name: "ws", commits: 10, files: 4 }],
      trail: {
        decisions_all: 5,
        tracks_open: [
          { id: "decision_B", title: "Track B" },
          { id: "decision_A", title: "Track A, retitled" },
        ],
      },
      components: {
        found: { ws: { kinds: ["ci", "manifest"], status: "known" } },
        unacknowledged: [],
        gone: ["ws/y"],
        kind_changed: null,
      },
    });
    const diff = diffMeasurements(measurement(), after, "01M4");
    expect(diff.values).toEqual([
      {
        at: 'trail.tracks_open["decision_A"].title',
        before: "Track A",
        after: "Track A, retitled",
      },
      {
        at: "components.found.ws.kinds",
        before: ["manifest"],
        after: ["ci", "manifest"],
      },
    ]);
    expect(diff.added).toEqual([
      { at: 'not_found["measures.md"].reason', value: "gone" },
      { at: 'trail.tracks_open["decision_B"].title', value: "Track B" },
      { at: 'components.gone["ws/y"]', value: true },
    ]);
    expect(diff.removed).toEqual([
      { at: 'repos["../basou"].name', value: "basou" },
      { at: 'repos["../basou"].commits', value: 100 },
      { at: 'repos["../basou"].files', value: 40 },
      { at: 'components.unacknowledged["ws/x"]', value: true },
    ]);
  });

  it("lists the methods that changed, and marks what moved in their sections", () => {
    const before = measurement({ methods: { repos: 1, components: 1, trail: 1 } });
    const after = measurement({
      methods: { repos: 1, components: 2, axis: 2 },
      repos: [
        { path: ".", name: "ws", commits: 11, files: 4 },
        { path: "../basou", name: "basou", commits: 100, files: 40 },
      ],
      components: {
        found: {
          ws: { kinds: ["manifest"], status: "known" },
          "ws/z": { kinds: ["ci"], status: "unacknowledged" },
        },
        unacknowledged: ["ws/x", "ws/z"],
        gone: [],
        kind_changed: null,
      },
    });
    const diff = diffMeasurements(before, after, "01M4");
    expect(diff.methods).toEqual([
      { section: "components", before: 1, after: 2 },
      { section: "axis", before: null, after: 2 },
      { section: "trail", before: 1, after: null },
    ]);
    expect(diff.values).toEqual([{ at: 'repos["."].commits', before: 10, after: 11, delta: 1 }]);
    expect(diff.added).toEqual([
      { at: 'components.found["ws/z"].kinds', value: ["ci"], method_changed: true },
      { at: 'components.found["ws/z"].status', value: "unacknowledged", method_changed: true },
      { at: 'components.unacknowledged["ws/z"]', value: true, method_changed: true },
    ]);
  });
});

describe("diffMeasurements: a measure's lanes", () => {
  const withLane = (lane?: unknown) =>
    measurement({
      measures: { md: { value: 2, unit: "files", ...(lane === undefined ? {} : { lane }) } },
    });

  it("reads one lane id, as a record of version 1 or 2 holds it, as a list of that one", () => {
    expect(diffMeasurements(withLane("core"), withLane(["core"]), "01M4")).toEqual({
      against: "01M4",
      values: [],
      methods: [],
      added: [],
      removed: [],
    });
    expect(diffMeasurements(withLane("core"), withLane(["core", "docs"]), "01M4").values).toEqual([
      { at: "measures.md.lane", before: ["core"], after: ["core", "docs"] },
    ]);
    expect(diffMeasurements(withLane(), withLane(["core"]), "01M4").added).toEqual([
      { at: "measures.md.lane", value: ["core"] },
    ]);
    expect(diffMeasurements(withLane("core"), withLane(), "01M4").removed).toEqual([
      { at: "measures.md.lane", value: ["core"] },
    ]);
  });
});

describe("diffMeasurements: what the digest leaves out", () => {
  it("does not compare the axis's not_found entries, nor the order an object's keys were written in", () => {
    const before = measurement({
      not_found: [{ at: "axis.review_needed", reason: "(c) could not be judged" }],
      measures: { md: { value: 2, unit: "files" } },
    });
    const after = measurement({
      not_found: [
        { at: "axis.last_review", reason: "not known" },
        { at: "axis", reason: "whole" },
        { at: "axisx", reason: "not the axis's" },
      ],
      measures: { md: { unit: "files", value: 2 } },
    });
    const diff = diffMeasurements(before, after, "01M4");
    expect(diff.values).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([{ at: 'not_found["axisx"].reason', value: "not the axis's" }]);
  });
});

describe("diffCells", () => {
  it("lists the cells whose state moved, and those there only now or only then", () => {
    const cell = (lane: string, stage: string, state: string) => ({ lane, stage, state });
    expect(
      diffCells(
        [cell("core", "01", "done"), cell("core", "02", "none"), cell("old", "01", "part")],
        [cell("core", "01", "done"), cell("core", "02", "part"), cell("new", "01", "none")],
      ),
    ).toEqual([
      { lane: "core", stage: "02", before: "none", after: "part" },
      { lane: "new", stage: "01", before: null, after: "none" },
      { lane: "old", stage: "01", before: "part", after: null },
    ]);
  });
});

describe("diffObserved", () => {
  it("lists the observations whose value or error moved, and those there only now or only then", () => {
    const at = { observed_at: "2026-10-07", source: "s" };
    // As a record and an input hold them, with when and where they were observed.
    const before = {
      npm: { value: "0.64.0", ...at },
      site: { value: "0.64.0", ...at },
      same: { value: { a: [1] }, ...at },
      gone: { value: 1, ...at },
    };
    const after = {
      npm: { value: "0.65.0", ...at },
      site: { value: null, error: "timeout", ...at },
      same: { value: { a: [1] }, ...at, source: "elsewhere" },
      fresh: { value: true, ...at },
    };
    expect(diffObserved(before, after)).toEqual([
      { name: "npm", before: { value: "0.64.0" }, after: { value: "0.65.0" } },
      { name: "site", before: { value: "0.64.0" }, after: { value: null, error: "timeout" } },
      { name: "fresh", before: null, after: { value: true } },
      { name: "gone", before: { value: 1 }, after: null },
    ]);
    const keyed = { v: { value: { x: 1, y: [{ a: 1, b: 2 }] } } };
    const reordered = { v: { value: { y: [{ b: 2, a: 1 }], x: 1 } } };
    expect(diffObserved(keyed, reordered)).toEqual([]);
    expect(diffObserved(keyed, { v: { value: { x: 1, y: [{ a: 1, b: 3 }] } } })).toHaveLength(1);
  });
});

describe("diffDeclarations", () => {
  const STAGES = Object.fromEntries(
    ["01", "02", "03", "04", "05", "06"].map((id) => [id, { meaning: `stage ${id}` }]),
  );
  // A declaration as a record of version 3 holds it, its defaults filled in.
  function declaration(over: Record<string, unknown> = {}) {
    return {
      title: "Board",
      stages: STAGES,
      lanes: [
        { id: "web", name: "Web" },
        { id: "cli", name: "CLI", notes: ["mind the flags"] },
      ],
      measures: [
        {
          id: "readme.latest",
          kind: "file_count",
          unit: "files",
          lane: ["web"],
          repo: ".",
          at: "worktree",
          include: ["*.md"],
        },
        {
          id: "src",
          kind: "line_count",
          unit: "lines",
          repo: ".",
          at: "worktree",
          include: ["src/**"],
        },
      ],
      ratios: [
        { id: "r", label: "Docs to source", numerator: "readme.latest", denominator: "src" },
      ],
      components: { "app/db": { lane: ["cli"] }, app: { lane: "-", note: "the root" } },
      axis: { version: 1, review_due_days: 60 },
      effort: { start: "2026-04-28", time_zone: "Asia/Tokyo" },
      observe: [{ key: "site.top", kind: "http", url: "https://example.com/" }],
      ...over,
    };
  }

  it("finds nothing changed in the same declaration, one of version 1 or 2 included", () => {
    expect(diffDeclarations(declaration(), declaration())).toEqual([]);
    // A record of version 1 holds a measure's lane as one id and no observe:
    // the same board read as version 3 has not changed.
    const v1 = declaration({ observe: undefined }) as Record<string, unknown>;
    delete v1.observe;
    v1.measures = (v1.measures as Record<string, unknown>[]).map((m) =>
      m.lane === undefined ? m : { ...m, lane: "web" },
    );
    expect(diffDeclarations(v1, declaration({ observe: [] }))).toEqual([]);
    // A key whose value is undefined is not there, as in a record.
    expect(diffDeclarations(declaration(), { ...declaration(), extra: undefined })).toEqual([]);
  });

  it("names each place that changed as a diff names a value, in the order the declaration holds them", () => {
    const after = declaration({
      stages: { ...STAGES, "03": { meaning: "stage 03", look: ["the tests"] } },
      lanes: [
        { id: "cli", name: "CLI", notes: ["mind the flags", "and the exit codes"] },
        { id: "web", name: "Web", about: "the site" },
        { id: "api", name: "API" },
      ],
      measures: [
        {
          id: "readme.latest",
          kind: "file_count",
          unit: "files",
          lane: ["web"],
          repo: ".",
          at: "HEAD",
          include: ["*.md", "docs/*.md"],
        },
        {
          id: "src",
          kind: "line_count",
          unit: "lines",
          repo: ".",
          at: "worktree",
          include: ["src/**"],
        },
      ],
      ratios: [
        { id: "r", label: "Docs per source", numerator: "readme.latest", denominator: "src" },
      ],
      components: { "app/db": { lane: ["web"] }, "app/web": { lane: ["web"] } },
      axis: { version: 2, review_due_days: 60, seed_review: { date: "2026-10-01", model: "M" } },
      effort: {
        start: "2026-04-28",
        time_zone: "Asia/Tokyo",
        milestones: [{ date: "2026-05-01", label: "Open", ref: "v0.1.0" }],
      },
      observe: [
        { key: "site.top", kind: "http", url: "https://example.com/", words: ["in stock"] },
        { key: "npm", kind: "npm_version", package: "basou", notes: ["the latest tag"] },
      ],
    });
    expect(diffDeclarations(declaration(), after)).toEqual([
      { at: "stages.03.look", change: "added" },
      { at: 'lanes["cli"].notes', change: "changed" },
      { at: 'lanes["web"].about', change: "added" },
      { at: 'lanes["api"]', change: "added" },
      { at: "lanes", change: "reordered" },
      { at: 'measures["readme.latest"].at', change: "changed" },
      { at: 'measures["readme.latest"].include', change: "changed" },
      { at: 'ratios["r"].label', change: "changed" },
      { at: 'components["app/db"].lane', change: "changed" },
      { at: 'components["app/web"]', change: "added" },
      { at: "components.app", change: "removed" },
      { at: "axis.version", change: "changed" },
      { at: "axis.seed_review", change: "added" },
      { at: "effort.milestones", change: "added" },
      { at: 'observe["site.top"].words', change: "added" },
      { at: 'observe["npm"]', change: "added" },
    ]);
    expect(
      diffDeclarations(
        declaration({ observe: [{ key: "site.top", kind: "http", url: "https://a.example/" }] }),
        declaration({
          observe: [{ key: "site.top", kind: "page_version", url: "https://a.example/" }],
        }),
      ),
    ).toEqual([{ at: 'observe["site.top"].kind', change: "changed" }]);
    expect(diffDeclarations(declaration(), declaration({ observe: [] }))).toEqual([
      { at: 'observe["site.top"]', change: "removed" },
    ]);
  });

  it("leaves out what the measurement's diff shows already", () => {
    const after = declaration({
      title: "Another board",
      measures: [
        // The unit and the lanes are values of the measurement.
        {
          id: "readme.latest",
          kind: "file_count",
          unit: "docs",
          repo: ".",
          at: "worktree",
          include: ["*.md"],
        },
        {
          id: "src",
          kind: "line_count",
          unit: "lines",
          lane: ["cli"],
          repo: ".",
          at: "worktree",
          include: ["src/**"],
        },
        // A measure added is a value added.
        {
          id: "more",
          kind: "file_count",
          unit: "files",
          repo: ".",
          at: "worktree",
          include: ["*"],
        },
      ],
      ratios: [
        { id: "r", label: "Docs to source", numerator: "src", denominator: "readme.latest" },
        { id: "s", label: "New", numerator: "src", denominator: "more" },
      ],
      effort: { start: "2026-05-01", time_zone: "UTC" },
    });
    expect(diffDeclarations(declaration(), after)).toEqual([]);
    // A measure and a ratio removed are values removed.
    expect(diffDeclarations(after, declaration())).toEqual([]);
    // A time zone declared only once may be this host's either way: it is listed.
    const without = declaration({ effort: { start: "2026-04-28" } });
    expect(diffDeclarations(declaration(), without)).toEqual([
      { at: "effort.time_zone", change: "removed" },
    ]);
    expect(diffDeclarations(without, declaration())).toEqual([
      { at: "effort.time_zone", change: "added" },
    ]);
  });

  it("says the lanes' order changed only when the lanes both hold are in another order", () => {
    const lane = (id: string) => ({ id, name: id.toUpperCase() });
    const lanes = (...ids: string[]) => declaration({ lanes: ids.map(lane) });
    // A lane added or removed leaves the others in their order.
    expect(diffDeclarations(lanes("web", "cli"), lanes("web", "cli", "api"))).toEqual([
      { at: 'lanes["api"]', change: "added" },
    ]);
    expect(diffDeclarations(lanes("web", "api", "cli"), lanes("web", "cli"))).toEqual([
      { at: 'lanes["api"]', change: "removed" },
    ]);
    expect(diffDeclarations(lanes("web", "cli"), lanes("api", "web", "cli"))).toEqual([
      { at: 'lanes["api"]', change: "added" },
    ]);
    expect(diffDeclarations(lanes("web", "cli", "api"), lanes("cli", "web"))).toEqual([
      { at: 'lanes["api"]', change: "removed" },
      { at: "lanes", change: "reordered" },
    ]);
    // The order of the measures, the ratios and the observations is no change.
    const before = declaration({
      measures: [
        { id: "a", kind: "file_count", unit: "files", repo: ".", at: "worktree", include: ["*"] },
        { id: "b", kind: "file_count", unit: "files", repo: ".", at: "worktree", include: ["*"] },
      ],
      ratios: [
        { id: "r", label: "R", numerator: "a", denominator: "b" },
        { id: "s", label: "S", numerator: "b", denominator: "a" },
      ],
      observe: [
        { key: "one", kind: "npm_version", package: "one" },
        { key: "two", kind: "npm_version", package: "two" },
      ],
    });
    const reversed = Object.fromEntries(
      Object.entries(before).map(([key, value]) => [
        key,
        key === "lanes" || !Array.isArray(value) ? value : [...value].reverse(),
      ]),
    );
    expect(diffDeclarations(before, reversed)).toEqual([]);
  });

  it("says nothing it cannot compare rather than throw, for a declaration nested too deep", () => {
    const depth = 100_000;
    const deep = JSON.parse(`${"[".repeat(depth)}"x"${"]".repeat(depth)}`);
    expect(() => JSON.stringify(deep)).toThrow(RangeError);
    const notes = (n: unknown) => declaration({ lanes: [{ id: "web", name: "Web", notes: n }] });
    // Compared whole, with what the board declares now.
    expect(diffDeclarations(notes(deep), notes(["x"]))).toBeNull();
    // Only in the previous record: not walked into, so it is said.
    expect(diffDeclarations(declaration({ deeper: deep }), declaration())).toEqual([
      { at: "deeper", change: "removed" },
    ]);
    // Deep as an object on both sides, walked key by key.
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < depth; i++) nested = { a: nested };
    expect(
      diffDeclarations(declaration({ axis: nested }), declaration({ axis: nested })),
    ).toBeNull();
  });

  it("compares a list it cannot tell the entries of whole, and has nothing to compare with no declaration", () => {
    const twice = declaration({
      lanes: [
        { id: "web", name: "Web" },
        { id: "web", name: "Web again" },
      ],
    });
    expect(diffDeclarations(twice, declaration())).toEqual([{ at: "lanes", change: "changed" }]);
    expect(diffDeclarations(declaration({ observe: "none" }), declaration())).toEqual([
      { at: "observe", change: "changed" },
    ]);
    // A key that is not a plain word is quoted, as a diff quotes it.
    expect(
      diffDeclarations(
        declaration({ stages: { ...STAGES, "a b": { meaning: "x" } } }),
        declaration(),
      ),
    ).toEqual([{ at: 'stages["a b"]', change: "removed" }]);
    for (const none of [null, "x", [], undefined]) {
      expect(diffDeclarations(none, declaration())).toBeNull();
    }
  });
});
