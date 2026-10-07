import { describe, expect, it } from "vitest";
import { diffCells, diffMeasurements, diffObserved } from "./diff.js";

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
