import { describe, expect, it } from "vitest";
import { type AxisInput, judgeAxis, modelKey, sameModel } from "./axis.js";
import type { BoardComponents } from "./components.js";

const QUIET: BoardComponents = { found: {}, unacknowledged: [], gone: [], kind_changed: null };
const SEED = { date: "2026-09-28", model: "Claude Opus 5.5" };

function judged(over: Partial<AxisInput> = {}) {
  return judgeAxis({
    declared: { version: 2, review_due_days: 60, seed_review: SEED },
    components: QUIET,
    today: "2026-10-07",
    ...over,
  });
}

const E = { trigger: "e", why: "there is no previous record to compare the methods with" };
const NO_MODEL = { trigger: "c", why: "no --model was given" };

describe("judgeAxis", () => {
  it("needs no review when nothing fired, and lists what it did not judge", () => {
    const { axis, notFound } = judged();
    expect(axis).toEqual({
      version: 2,
      review_needed: false,
      reasons: [],
      unjudged: [NO_MODEL, E],
      last_review: { date: "2026-09-28", model: "Claude Opus 5.5", from: "seed" },
    });
    expect(notFound).toEqual([]);
  });

  it("fires (a) on a component unacknowledged, gone or with changed kinds", () => {
    const fired = (components: BoardComponents) => judged({ components }).axis.reasons;
    expect(fired({ ...QUIET, unacknowledged: ["app/x"] })).toEqual([
      { trigger: "a", detail: "components: 1 unacknowledged, 0 gone" },
    ]);
    expect(fired({ ...QUIET, gone: ["app/y", "app/z"] })).toEqual([
      { trigger: "a", detail: "components: 0 unacknowledged, 2 gone" },
    ]);
    expect(fired({ ...QUIET, kind_changed: [{ key: "app", before: [], after: ["ci"] }] })).toEqual([
      { trigger: "a", detail: "components: 0 unacknowledged, 0 gone, 1 with changed kinds" },
    ]);
    expect(fired({ ...QUIET, kind_changed: [] })).toEqual([]);
  });

  it("fires (b) from review_due_days on, not a day before, and not for a review in the future", () => {
    const due = (today: string) => judged({ today }).axis.reasons;
    expect(due("2026-11-26")).toEqual([]);
    expect(due("2026-11-27")).toEqual([
      { trigger: "b", detail: "60 days since the review of 2026-09-28 (due after 60)" },
    ]);
    // A review dated later than today, by more than the days due, is not due.
    expect(
      judged({
        declared: { version: 2, review_due_days: 60, seed_review: { ...SEED, date: "2027-03-01" } },
      }).axis.reasons,
    ).toEqual([]);
  });

  it("fires (c) for another model, comparing the names as keys", () => {
    const by = (model: string) => judged({ model }).axis;
    expect(by("claude-opus-5-5").reasons).toEqual([]);
    expect(by("  CLAUDE   opus 5.5 ").reasons).toEqual([]);
    expect(by("  CLAUDE   opus 5.5 ").unjudged).toEqual([E]);
    expect(by("Claude Fable 5.1").reasons).toEqual([
      { trigger: "c", detail: "Claude Fable 5.1 judges; Claude Opus 5.5 reviewed last" },
    ]);
    expect(by("Claude Fable 5.1").review_needed).toBe(true);
  });

  it("fires (b), and (c) when a model is given, with no review on record", () => {
    const declared = { version: 1, review_due_days: 60 };
    expect(judged({ declared }).axis).toMatchObject({
      review_needed: true,
      reasons: [{ trigger: "b", detail: "the axis has no review on record" }],
      unjudged: [NO_MODEL, E],
      last_review: null,
    });
    expect(judged({ declared, model: "x" }).axis.reasons).toEqual([
      { trigger: "b", detail: "the axis has no review on record" },
      { trigger: "c", detail: "the axis has no review on record" },
    ]);
  });

  it("does not know whether a review is needed when (a) or (b) cannot be judged and nothing fired", () => {
    const unmeasured = { found: null, unacknowledged: null, gone: null, kind_changed: null };
    const a = judged({ components: unmeasured });
    expect(a.axis.review_needed).toBeNull();
    expect(a.axis.unjudged[0]).toEqual({ trigger: "a", why: "the components were not measured" });
    expect(a.notFound).toEqual([
      {
        at: "axis.review_needed",
        reason: "no trigger fired, but (a) could not be judged: the components were not measured",
      },
    ]);
    const b = judged({ today: undefined });
    expect(b.axis.review_needed).toBeNull();
    expect(b.notFound[0]?.reason).toBe(
      "no trigger fired, but (b) could not be judged: this host's time zone could not be named, so the days are not known (declare effort.time_zone)",
    );
    // A trigger that fired settles it whatever could not be judged.
    const fired = judged({ components: unmeasured, model: "Claude Fable 5.1" });
    expect(fired.axis.review_needed).toBe(true);
    expect(fired.notFound).toEqual([]);
  });
});

describe("modelKey", () => {
  it("lowers the case and makes each run of anything but an ASCII letter or digit one '-', none at the ends", () => {
    expect(modelKey("Claude Opus 5.5")).toBe("claude-opus-5-5");
    expect(modelKey("  claude__opus--5.5  ")).toBe("claude-opus-5-5");
    expect(modelKey("Claude Opus 5.5（日本語）")).toBe("claude-opus-5-5");
  });
});

describe("sameModel", () => {
  it("compares by key, or by the names when either has nothing to key on", () => {
    expect(sameModel("Claude Opus 5.5", "claude-opus-5-5")).toBe(true);
    expect(sameModel("日本語モデル", "別のモデル")).toBe(false);
    expect(sameModel(" 日本語モデル", "日本語モデル ")).toBe(true);
    expect(sameModel("!!!", "Claude")).toBe(false);
  });

  it("says one day, and more days", () => {
    const one = judgeAxis({
      declared: { version: 1, review_due_days: 1, seed_review: { date: "2026-12-31", model: "x" } },
      components: QUIET,
      today: "2027-01-01",
    });
    expect(one.axis.reasons).toEqual([
      { trigger: "b", detail: "1 day since the review of 2026-12-31 (due after 1)" },
    ]);
  });
});

describe("judgeAxis against the records", () => {
  const METHODS = { repos: 1, components: 2, axis: 2 };

  it("fires (e) for each section whose method is not the previous record's, one it lacked included", () => {
    const { axis } = judged({
      methods: METHODS,
      previousMethods: { status: "found", methods: { repos: 1, components: 1, gone: 3 } },
    });
    expect(axis.reasons).toEqual([
      {
        trigger: "e",
        detail:
          "methods changed since the previous record: components 1 -> 2, axis none -> 2, gone 3 -> none",
      },
    ]);
    expect(axis.unjudged).toEqual([NO_MODEL]);
    const same = judged({
      methods: METHODS,
      previousMethods: { status: "found", methods: METHODS },
    });
    expect(same.axis.reasons).toEqual([]);
    expect(same.axis.review_needed).toBe(false);
  });

  it("does not know whether a review is needed when the previous record cannot be read", () => {
    const { axis, notFound } = judged({
      methods: METHODS,
      previousMethods: { status: "unreadable", reason: "the record X could not be read as JSON" },
    });
    expect(axis.unjudged).toEqual([
      NO_MODEL,
      {
        trigger: "e",
        why: "the previous record could not be read: the record X could not be read as JSON",
      },
    ]);
    expect(axis.review_needed).toBeNull();
    expect(notFound).toEqual([
      {
        at: "axis.review_needed",
        reason:
          "no trigger fired, but (e) could not be judged: the previous record could not be read: the record X could not be read as JSON",
      },
    ]);
  });

  it("takes the last review from a record before the seed, for (b) and (c)", () => {
    const { axis } = judged({
      model: "Claude Opus 5.5",
      recordedReview: { status: "found", date: "2026-08-01", model: "Other Model", record: "01M4" },
    });
    expect(axis.last_review).toEqual({
      date: "2026-08-01",
      model: "Other Model",
      from: "record",
      record: "01M4",
    });
    expect(axis.reasons).toEqual([
      { trigger: "b", detail: "67 days since the review of 2026-08-01 (due after 60)" },
      { trigger: "c", detail: "Claude Opus 5.5 judges; Other Model reviewed last" },
    ]);
  });

  it("judges neither (b) nor (c) when a record that may hold the last review cannot be read", () => {
    const why = "the last review is not known: the record Y could not be read as JSON";
    const { axis, notFound } = judged({
      model: "Claude Opus 5.5",
      recordedReview: { status: "unreadable", reason: "the record Y could not be read as JSON" },
    });
    expect(axis.last_review).toBeNull();
    expect(axis.reasons).toEqual([]);
    expect(axis.unjudged).toEqual([{ trigger: "b", why }, { trigger: "c", why }, E]);
    expect(axis.review_needed).toBeNull();
    expect(notFound).toEqual([
      { at: "axis.last_review", reason: why },
      {
        at: "axis.review_needed",
        reason: `no trigger fired, but (b) could not be judged: ${why}; (c) could not be judged: ${why}`,
      },
    ]);
  });

  it("judges (a) on what is known when what only the previous record found is not", () => {
    const unknownGone = { ...QUIET, gone: null };
    expect(judged({ components: unknownGone }).axis.unjudged).toContainEqual({
      trigger: "a",
      why: "what the previous record alone found is not known",
    });
    expect(
      judged({ components: { ...unknownGone, unacknowledged: ["app/x"] } }).axis.reasons,
    ).toEqual([{ trigger: "a", detail: "components: 1 unacknowledged, 0 registered gone" }]);
    // What the declaration registers and was not found is known, and fires it.
    const registered = judged({ components: unknownGone, declaredGone: ["app/y"] });
    expect(registered.axis.reasons).toEqual([
      { trigger: "a", detail: "components: 0 unacknowledged, 1 registered gone" },
    ]);
    expect(registered.axis.review_needed).toBe(true);
  });
});
