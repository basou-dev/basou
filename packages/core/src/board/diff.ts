/** A value that moved since the previous record. */
export type BoardValueChange = {
  /** Where it is, as `repos["../basou"].commits`. */
  at: string;
  before: unknown;
  after: unknown;
  /** After less before, when both are numbers. */
  delta?: number;
  /**
   * Present when the method of the value's section changed since the
   * previous record: the move may be the method's rather than the board's.
   */
  method_changed?: true;
};

/** A value there only now, or only in the previous record. */
export type BoardValueOnly = { at: string; value: unknown; method_changed?: true };

/** A built-in section whose method is not the previous record's (null where it had none). */
export type BoardMethodChange = { section: string; before: number | null; after: number | null };

/**
 * What moved since the previous record, value by value. Compared are the
 * values the digest holds but `measured_with`, the methods (compared on their
 * own), `effort.daily`, whose rows only grow, and `components.kind_changed`,
 * already a change since the previous record. A list whose entries name
 * themselves is compared entry by entry (`repos` by path, open tracks by id,
 * `not_found` by where), the unacknowledged and gone components as sets, and
 * any other list whole.
 */
export type BoardDiff = {
  /** The previous record's name, its ULID. */
  against: string;
  values: BoardValueChange[];
  methods: BoardMethodChange[];
  added: BoardValueOnly[];
  removed: BoardValueOnly[];
};

// Left out at the top: what is not a value the board measured, what the
// digest leaves out, and the diff itself.
const UNCOMPARED = new Set([
  "measured_at",
  "measured_with",
  "digest",
  "methods",
  "freshness",
  "axis",
  "diff",
]);
// Left out further down.
const SKIPPED = new Set(["effort.elapsed_days", "effort.daily", "components.kind_changed"]);
// Lists whose entries are told apart by a field of theirs.
const KEYED: Readonly<Record<string, string>> = {
  repos: "path",
  "trail.tracks_open": "id",
  not_found: "at",
};
// Lists of names, compared as sets.
const SETS = new Set(["components.unacknowledged", "components.gone"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shownKey(shown: string, key: string): string {
  if (shown === "") return key;
  return /^[A-Za-z0-9_-]+$/.test(key) ? `${shown}.${key}` : `${shown}[${JSON.stringify(key)}]`;
}

type Leaf = { value: unknown; section: string };

// Each value of a measurement by where it is, with the section it is in.
function leaves(measurement: unknown): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  const walk = (value: unknown, rule: string, shown: string, section: string): void => {
    if (SKIPPED.has(rule)) return;
    if (Array.isArray(value)) {
      const field = KEYED[rule];
      if (field !== undefined) {
        for (const entry of value) {
          if (!isRecord(entry)) continue;
          const { [field]: name, ...rest } = entry;
          walk(rest, `${rule}[]`, `${shown}[${JSON.stringify(String(name))}]`, section);
        }
      } else if (SETS.has(rule)) {
        for (const name of value) {
          out.set(`${shown}[${JSON.stringify(String(name))}]`, { value: true, section });
        }
      } else {
        out.set(shown, { value, section });
      }
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (rule === "" && UNCOMPARED.has(key)) continue;
        walk(
          child,
          rule === "" ? key : `${rule}.${key}`,
          shownKey(shown, key),
          section === "" ? key : section,
        );
      }
      return;
    }
    out.set(shown, { value, section });
  };
  walk(measurement, "", "", "");
  return out;
}

function methodsOf(measurement: unknown): Record<string, unknown> {
  return isRecord(measurement) && isRecord(measurement.methods) ? measurement.methods : {};
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What moved from the previous record's measurement to this one. */
export function diffMeasurements(before: unknown, after: unknown, against: string): BoardDiff {
  const [methodsBefore, methodsAfter] = [methodsOf(before), methodsOf(after)];
  const sections = [...new Set([...Object.keys(methodsAfter), ...Object.keys(methodsBefore)])];
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const methods = sections
    .filter((section) => !same(methodsBefore[section], methodsAfter[section]))
    .map((section) => ({
      section,
      before: number(methodsBefore[section]),
      after: number(methodsAfter[section]),
    }));
  const changed = new Set(methods.map((m) => m.section));
  const flag = (section: string) => (changed.has(section) ? { method_changed: true as const } : {});

  const [was, is] = [leaves(before), leaves(after)];
  const values: BoardValueChange[] = [];
  const added: BoardValueOnly[] = [];
  for (const [at, leaf] of is) {
    const old = was.get(at);
    if (old === undefined) {
      added.push({ at, value: leaf.value, ...flag(leaf.section) });
    } else if (!same(old.value, leaf.value)) {
      const delta =
        typeof old.value === "number" && typeof leaf.value === "number"
          ? { delta: leaf.value - old.value }
          : {};
      values.push({ at, before: old.value, after: leaf.value, ...delta, ...flag(leaf.section) });
    }
  }
  const removed: BoardValueOnly[] = [];
  for (const [at, leaf] of was) {
    if (!is.has(at)) removed.push({ at, value: leaf.value, ...flag(leaf.section) });
  }
  return { against, values, methods, added, removed };
}

/** A cell whose state is not the previous record's (null where there was no such cell). */
export type BoardCellChange = {
  lane: string;
  stage: string;
  before: string | null;
  after: string | null;
};

/** The cells whose state moved, in the order given now, then those only the previous record had. */
export function diffCells(
  before: readonly { lane: string; stage: string; state: string }[],
  after: readonly { lane: string; stage: string; state: string }[],
): BoardCellChange[] {
  const key = (c: { lane: string; stage: string }) => `${c.lane}\0${c.stage}`;
  const was = new Map(before.map((c) => [key(c), c.state]));
  const is = new Set(after.map(key));
  const out: BoardCellChange[] = [];
  for (const cell of after) {
    const old = was.get(key(cell)) ?? null;
    if (old !== cell.state) {
      out.push({ lane: cell.lane, stage: cell.stage, before: old, after: cell.state });
    }
  }
  for (const cell of before) {
    if (!is.has(key(cell))) {
      out.push({ lane: cell.lane, stage: cell.stage, before: cell.state, after: null });
    }
  }
  return out;
}

/** An observation as a diff shows it. */
export type BoardObservation = { value: unknown; error?: string };

// An observation as a record or an input holds it, with what else it has.
type ObservedEntry = { value: unknown; error?: string | undefined };

/** An observation that moved (null where there was no observation of that name). */
export type BoardObservedChange = {
  name: string;
  before: BoardObservation | null;
  after: BoardObservation | null;
};

/**
 * The observations whose value or error moved, one observed now that was not
 * then, or one observed then that is not now: in the order given now, then
 * those only the previous record had.
 */
export function diffObserved(
  before: Readonly<Record<string, ObservedEntry>>,
  after: Readonly<Record<string, ObservedEntry>>,
): BoardObservedChange[] {
  const shown = (o: ObservedEntry): BoardObservation =>
    o.error === undefined ? { value: o.value } : { value: o.value, error: o.error };
  const out: BoardObservedChange[] = [];
  for (const [name, now] of Object.entries(after)) {
    const then = Object.hasOwn(before, name) ? before[name] : undefined;
    if (then === undefined) out.push({ name, before: null, after: shown(now) });
    else if (!same(shown(then), shown(now)))
      out.push({ name, before: shown(then), after: shown(now) });
  }
  for (const [name, then] of Object.entries(before)) {
    if (!Object.hasOwn(after, name)) out.push({ name, before: shown(then), after: null });
  }
  return out;
}
