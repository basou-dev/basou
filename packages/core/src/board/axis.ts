import type { BoardComponents } from "./components.js";
import { daysBetween } from "./effort.js";

/**
 * The version of how the `axis` section judges. Raised whenever a value of
 * the section would change for the same inputs, as when a trigger is judged
 * differently.
 */
export const BOARD_AXIS_METHOD = 1;

/** A trigger of an axis review that measure judges: (d), the operator's word, is not one. */
export type BoardAxisTrigger = "a" | "b" | "c" | "e";

/** A trigger that fired, with what it rests on. */
export type BoardAxisReason = { trigger: BoardAxisTrigger; detail: string };

/** A trigger that was not judged, and why. */
export type BoardAxisUnjudged = { trigger: BoardAxisTrigger; why: string };

/** The last review of the axis: for now, the declaration's `axis.seed_review`. */
export type BoardLastReview = { date: string; model: string; from: "seed" };

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
   * when none fired but (a) or (b) could not be judged because what it rests
   * on was not measured (the components, or a time zone to count days in).
   * False otherwise: a trigger with nothing to judge it by, (c) with no
   * `--model` or (e) with no previous record, is listed under `unjudged`
   * and does not keep it from being false.
   */
  review_needed: boolean | null;
  /** The triggers that fired, in the order a, b, c, e. */
  reasons: BoardAxisReason[];
  /** The triggers that were not judged, in the same order. */
  unjudged: BoardAxisUnjudged[];
  /** Null when there is none, which fires (b), and (c) when a model is given. */
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
  let unknown = false;
  const seed = input.declared.seed_review;
  const last: BoardLastReview | null =
    seed === undefined ? null : { date: seed.date, model: seed.model, from: "seed" };

  // (a)
  const { found, unacknowledged, gone, kind_changed } = input.components;
  if (found === null || unacknowledged === null || gone === null) {
    unjudged.push({ trigger: "a", why: "the components were not measured" });
    unknown = true;
  } else {
    const changed = kind_changed?.length ?? 0;
    if (unacknowledged.length > 0 || gone.length > 0 || changed > 0) {
      const parts = [`${unacknowledged.length} unacknowledged`, `${gone.length} gone`];
      if (kind_changed !== null) parts.push(`${changed} with changed kinds`);
      reasons.push({ trigger: "a", detail: `components: ${parts.join(", ")}` });
    }
  }

  // (b)
  if (last === null) {
    reasons.push({ trigger: "b", detail: "the axis has no review on record" });
  } else if (input.today === undefined) {
    unjudged.push({
      trigger: "b",
      why: "this host's time zone could not be named, so the days are not known (declare effort.time_zone)",
    });
    unknown = true;
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
  } else if (last === null) {
    reasons.push({ trigger: "c", detail: "the axis has no review on record" });
  } else if (!sameModel(input.model, last.model)) {
    reasons.push({
      trigger: "c",
      detail: `${input.model} judges; ${last.model} reviewed last`,
    });
  }

  // (e)
  unjudged.push({
    trigger: "e",
    why: "there is no previous record to compare the methods with",
  });

  const reviewNeeded = reasons.length > 0 ? true : unknown ? null : false;
  return {
    axis: {
      version: input.declared.version,
      review_needed: reviewNeeded,
      reasons,
      unjudged,
      last_review: last,
    },
    notFound:
      reviewNeeded === null
        ? [
            {
              at: "axis.review_needed",
              reason: `no trigger fired, but ${unjudged
                .filter((u) => u.trigger === "a" || u.trigger === "b")
                .map((u) => `(${u.trigger}) could not be judged: ${u.why}`)
                .join("; ")}`,
            },
          ]
        : [],
  };
}
