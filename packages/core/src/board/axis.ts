import type { BoardComponents } from "./components.js";
import { daysBetween } from "./effort.js";
import type { PreviousOutcome } from "./previous.js";

/**
 * The version of how the `axis` section judges. Raised whenever a value of
 * the section would change for the same inputs, as when a trigger is judged
 * differently.
 */
export const BOARD_AXIS_METHOD = 2;

/** A trigger of an axis review that measure judges: (d), the operator's word, is not one. */
export type BoardAxisTrigger = "a" | "b" | "c" | "e";

/** A trigger that fired, with what it rests on. */
export type BoardAxisReason = { trigger: BoardAxisTrigger; detail: string };

/** A trigger that was not judged, and why. */
export type BoardAxisUnjudged = { trigger: BoardAxisTrigger; why: string };

/**
 * The last review of the axis: the last record with an axis review (its
 * date in the effort section's time zone, and the model that judged it), or,
 * with no such record, the declaration's `axis.seed_review`.
 */
export type BoardLastReview =
  | { date: string; model: string; from: "seed" }
  | { date: string; model: string; from: "record"; record: string };

/**
 * Whether the board's axis is due a review, by the triggers measure can
 * judge: (a) the components changed, (b) `review_due_days` or more have
 * passed since the last review, (c) the model that judges is not the one
 * that reviewed last, (e) a built-in section's method changed since the
 * previous record. Left out of the digest: it rests on the day, the model
 * and the records rather than on what was measured.
 */
export type BoardAxis = {
  /** The declaration's `axis.version`. */
  version: number;
  /**
   * True when a trigger fired. Null, with an entry at `axis.review_needed`,
   * when none fired but one could not be judged because what it rests on was
   * not measured (the components, or a time zone to count days in) or a
   * record could not be read. False otherwise: a trigger with nothing to
   * judge it by, (c) with no `--model` or (e) with no previous record, is
   * listed under `unjudged` and does not keep it from being false.
   */
  review_needed: boolean | null;
  /** The triggers that fired, in the order a, b, c, e. */
  reasons: BoardAxisReason[];
  /** The triggers that were not judged, in the same order. */
  unjudged: BoardAxisUnjudged[];
  /**
   * Null when there is none, which fires (b), and (c) when a model is given.
   * Null with an entry at `axis.last_review` when a record that may hold it
   * cannot be read: (b) and (c) are then not judged.
   */
  last_review: BoardLastReview | null;
};

export type AxisInput = {
  declared: {
    version: number;
    review_due_days: number;
    seed_review?: { date: string; model: string } | undefined;
  };
  components: BoardComponents;
  /** Today in the effort section's time zone; undefined when it cannot be named. */
  today: string | undefined;
  /** The model that will judge the board, when one is given. */
  model?: string | undefined;
  /** The last review the records hold (default: there is none). */
  recordedReview?: PreviousOutcome<{ date: string; model: string; record: string }>;
  /** The methods of this measurement. */
  methods?: Readonly<Record<string, number>>;
  /** The methods of the previous record (default: there is no previous record). */
  previousMethods?: PreviousOutcome<{ methods: Readonly<Record<string, number>> }>;
};

/**
 * A model's name as it is compared: lower case, each run of anything but an
 * ASCII letter or digit as one '-', with none at either end.
 */
export function modelKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Whether two names name the same model: by {@link modelKey}, or, when either
 * has no ASCII letter or digit to key on, by the names themselves, lower case
 * and trimmed (so that two names in another script are not all one model).
 */
export function sameModel(a: string, b: string): boolean {
  const [x, y] = [modelKey(a), modelKey(b)];
  if (x !== "" && y !== "") return x === y;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The `axis` section of a measurement, and why it is missing when it is. */
export function judgeAxis(input: AxisInput): {
  axis: BoardAxis;
  notFound: { at: string; reason: string }[];
} {
  const reasons: BoardAxisReason[] = [];
  const unjudged: BoardAxisUnjudged[] = [];
  // The triggers not judged for want of what they rest on.
  const unknown = new Set<BoardAxisTrigger>();
  const notJudged = (trigger: BoardAxisTrigger, why: string) => {
    unjudged.push({ trigger, why });
    unknown.add(trigger);
  };
  const seed = input.declared.seed_review;
  const recorded = input.recordedReview ?? { status: "none" };
  const last: BoardLastReview | null =
    recorded.status === "found"
      ? { date: recorded.date, model: recorded.model, from: "record", record: recorded.record }
      : recorded.status === "unreadable" || seed === undefined
        ? null
        : { date: seed.date, model: seed.model, from: "seed" };
  const lastUnknown =
    recorded.status === "unreadable" ? `the last review is not known: ${recorded.reason}` : null;

  // (a)
  const { found, unacknowledged, gone, kind_changed } = input.components;
  if (found === null || unacknowledged === null) {
    notJudged("a", "the components were not measured");
  } else {
    const changed = kind_changed?.length ?? 0;
    if (unacknowledged.length > 0 || (gone?.length ?? 0) > 0 || changed > 0) {
      const parts = [`${unacknowledged.length} unacknowledged`];
      if (gone !== null) parts.push(`${gone.length} gone`);
      if (kind_changed !== null) parts.push(`${changed} with changed kinds`);
      reasons.push({ trigger: "a", detail: `components: ${parts.join(", ")}` });
    } else if (gone === null) {
      notJudged("a", "what the previous record alone found is not known");
    }
  }

  // (b)
  if (lastUnknown !== null) {
    notJudged("b", lastUnknown);
  } else if (last === null) {
    reasons.push({ trigger: "b", detail: "the axis has no review on record" });
  } else if (input.today === undefined) {
    notJudged(
      "b",
      "this host's time zone could not be named, so the days are not known (declare effort.time_zone)",
    );
  } else {
    const days = daysBetween(last.date, input.today);
    if (days >= input.declared.review_due_days) {
      reasons.push({
        trigger: "b",
        detail: `${days} day${days === 1 ? "" : "s"} since the review of ${last.date} (due after ${input.declared.review_due_days})`,
      });
    }
  }

  // (c)
  if (input.model === undefined) {
    unjudged.push({ trigger: "c", why: "no --model was given" });
  } else if (lastUnknown !== null) {
    notJudged("c", lastUnknown);
  } else if (last === null) {
    reasons.push({ trigger: "c", detail: "the axis has no review on record" });
  } else if (!sameModel(input.model, last.model)) {
    reasons.push({
      trigger: "c",
      detail: `${input.model} judges; ${last.model} reviewed last`,
    });
  }

  // (e)
  const previous = input.previousMethods ?? { status: "none" };
  if (previous.status === "none") {
    unjudged.push({ trigger: "e", why: "there is no previous record to compare the methods with" });
  } else if (previous.status === "unreadable") {
    notJudged("e", `the previous record could not be read: ${previous.reason}`);
  } else {
    const now = input.methods ?? {};
    const sections = [...new Set([...Object.keys(now), ...Object.keys(previous.methods)])];
    const moved = sections.filter((section) => now[section] !== previous.methods[section]);
    if (moved.length > 0) {
      const shown = (n: number | undefined) => (n === undefined ? "none" : String(n));
      reasons.push({
        trigger: "e",
        detail: `methods changed since the previous record: ${moved
          .map(
            (section) => `${section} ${shown(previous.methods[section])} -> ${shown(now[section])}`,
          )
          .join(", ")}`,
      });
    }
  }

  const reviewNeeded = reasons.length > 0 ? true : unknown.size > 0 ? null : false;
  return {
    axis: {
      version: input.declared.version,
      review_needed: reviewNeeded,
      reasons,
      unjudged,
      last_review: last,
    },
    notFound: [
      ...(lastUnknown === null ? [] : [{ at: "axis.last_review", reason: lastUnknown }]),
      ...(reviewNeeded === null
        ? [
            {
              at: "axis.review_needed",
              reason: `no trigger fired, but ${unjudged
                .filter((u) => unknown.has(u.trigger))
                .map((u) => `(${u.trigger}) could not be judged: ${u.why}`)
                .join("; ")}`,
            },
          ]
        : []),
    ],
  };
}
