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
 * measurement's values the digest holds (so not the axis's not_found entries
 * either, nor the declaration, which the digest also covers) but
 * `measured_with`, the methods (compared on their own), `effort.daily`, whose
 * rows only grow, and `components.kind_changed`, already a change since the
 * previous record. Values are equal when their JSON is, keys sorted, except
 * that a measure's lane held as one id, as a record of version 1 or 2 holds
 * it, is the list of that one a record of version 3 holds. A list whose entries name
 * themselves is compared entry by entry (`repos` by path, open tracks by id,
 * `not_found` by where), the unacknowledged and gone components as sets, the
 * paths of a `file_paths` measure as a set when both records hold a list (a
 * path that came in is added, one that went out removed), and any other list
 * whole.
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
const SKIPPED = new Set([
  "effort.elapsed_days",
  "effort.daily",
  "repos[].fetched_at",
  "components.kind_changed",
]);
// Lists whose entries are told apart by a field of theirs.
const KEYED: Readonly<Record<string, string>> = {
  repos: "path",
  "trail.tracks_open": "id",
  not_found: "at",
};
// Lists of names, compared as sets.
const SETS = new Set(["components.unacknowledged", "components.gone"]);

/**
 * The list and the name of an `added` or `removed` place that is a name coming
 * into or going out of a list compared as a set (`components.gone`, a
 * `file_paths` measure's `measures.<id>.value`), or `null` for any other place.
 * Such a place holds `true`, which says only that the name is listed: a line
 * drawn from it reads by the list and the name instead.
 */
export function setEntryOf(at: string): { list: string; name: string } | null {
  const match = /^(.+)\[("(?:[^"\\]|\\.)*")\]$/.exec(at);
  if (match === null) return null;
  const [, list = "", quoted = ""] = match;
  if (!SETS.has(list) && !/^measures(\.[A-Za-z0-9_-]+|\["(?:[^"\\]|\\.)*"\])\.value$/.test(list)) {
    return null;
  }
  try {
    const name: unknown = JSON.parse(quoted);
    return typeof name === "string" ? { list, name } : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shownKey(shown: string, key: string): string {
  if (shown === "") return key;
  return /^[A-Za-z0-9_-]+$/.test(key) ? `${shown}.${key}` : `${shown}[${JSON.stringify(key)}]`;
}

type Leaf = { value: unknown; section: string };

// A measure as a record of version 3 holds it: a record of version 1 or 2
// holds its lane as one id, which is the same lane as a list of that one.
function withLaneList(entry: unknown): unknown {
  return isRecord(entry) && typeof entry.lane === "string"
    ? { ...entry, lane: [entry.lane] }
    : entry;
}

// The measures whose value is a list in both measurements, by id: their
// paths are compared as a set. When one of them is not a list (not measured,
// or no such measure), the value is compared whole.
function setMeasures(before: unknown, after: unknown): Set<string> {
  const lists = (m: unknown): Set<string> => {
    const measures = isRecord(m) && isRecord(m.measures) ? m.measures : {};
    return new Set(
      Object.entries(measures)
        .filter(([, v]) => isRecord(v) && Array.isArray(v.value))
        .map(([id]) => id),
    );
  };
  const was = lists(before);
  return new Set([...lists(after)].filter((id) => was.has(id)));
}

// Each value of a measurement by where it is, with the section it is in.
function leaves(measurement: unknown, sets: ReadonlySet<string>): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  const walk = (value: unknown, rule: string, shown: string, section: string): void => {
    if (SKIPPED.has(rule)) return;
    if (rule === "measures" && isRecord(value)) {
      for (const [id, entry] of Object.entries(value)) {
        walk(
          withLaneList(entry),
          sets.has(id) ? "measures[set]" : "measures[]",
          shownKey(shown, id),
          section,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      const field = KEYED[rule];
      if (field !== undefined) {
        for (const entry of value) {
          if (!isRecord(entry)) continue;
          const { [field]: name, ...rest } = entry;
          // As the digest leaves them out: they come and go with the axis.
          if (rule === "not_found" && /^axis(\.|$)/.test(String(name))) continue;
          walk(rest, `${rule}[]`, `${shown}[${JSON.stringify(String(name))}]`, section);
        }
      } else if (SETS.has(rule) || rule === "measures[set].value") {
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

// JSON with every object's keys sorted, so that the order they were written
// in does not make two values differ.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

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

  const sets = setMeasures(before, after);
  const [was, is] = [leaves(before, sets), leaves(after, sets)];
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

/**
 * A place where the declaration a board was measured by is not the previous
 * record's: an entry or a key there only now (`added`), only then
 * (`removed`), or there in both with another value (`changed`); or, for the
 * lanes, the same lanes in another order (`reordered`).
 */
export type BoardDeclarationChange = {
  /** Where, as a diff names a value: `stages.03.look`, `lanes["web"].notes`. */
  at: string;
  change: "added" | "removed" | "changed" | "reordered";
};

// The lists of a declaration whose entries name themselves, by the field
// that names them.
const DECLARED_KEYED: Readonly<Record<string, string>> = {
  lanes: "id",
  measures: "id",
  ratios: "id",
  observe: "key",
};
// What the diff of the measurement shows already, as a value of the
// measurement that moved: the title, a measure's unit and lanes, a ratio's
// numerator and denominator, and the effort's start.
const DECLARED_IN_VALUES = new Set([
  "title",
  "measures[].unit",
  "measures[].lane",
  "ratios[].numerator",
  "ratios[].denominator",
  "effort.start",
]);
// The lists whose entries, added or removed, the diff of the measurement
// shows as values added or removed.
const ENTRIES_IN_VALUES = new Set(["measures", "ratios"]);

// The entries of a list by the field that names them, or undefined when an
// entry is not an object named by a string, or a name is given twice: such a
// list is compared whole.
function byName(list: unknown, field: string): Map<string, unknown> | undefined {
  if (!Array.isArray(list)) return undefined;
  const out = new Map<string, unknown>();
  for (const entry of list) {
    if (!isRecord(entry)) return undefined;
    const name = entry[field];
    if (typeof name !== "string" || out.has(name)) return undefined;
    out.set(name, entry);
  }
  return out;
}

/**
 * Where the declaration a board is measured by now differs from the one the
 * previous record holds, in the order the declaration holds its keys, then
 * those only the previous one had. Both are compared as a record holds them:
 * their defaults filled in, and a record of version 1 with `observe` as `[]`.
 * A list whose entries name themselves is compared entry by entry (lanes,
 * measures and ratios by id, observations by key, and the lanes' order on its
 * own), and any other list whole. Left out is what the measurement's diff
 * shows already: the title, a measure's unit and lanes (there a lane of one
 * id, as a record of version 1 or 2 holds it, is the list of that one, so
 * moving a board to version 3 shows nothing for that alone), a ratio's
 * numerator and denominator, the effort's start, a time zone declared in
 * both, and a measure or a ratio added or removed. Null when the previous
 * record holds no declaration as an object, or one too deep to compare: it
 * never throws, so a caller that has written a record goes on.
 */
export function diffDeclarations(before: unknown, after: unknown): BoardDeclarationChange[] | null {
  if (!isRecord(before) || !isRecord(after)) return null;
  const was = Object.hasOwn(before, "observe") ? before : { ...before, observe: [] };
  const out: BoardDeclarationChange[] = [];
  const walk = (then: unknown, now: unknown, rule: string, shown: string): void => {
    if (DECLARED_IN_VALUES.has(rule)) return;
    if (then === undefined && now === undefined) return;
    if (then === undefined || now === undefined) {
      out.push({ at: shown, change: then === undefined ? "added" : "removed" });
      return;
    }
    // The measurement's time zone is the one declared, when one is.
    if (rule === "effort.time_zone" && typeof then === "string" && typeof now === "string") return;
    const field = DECLARED_KEYED[rule];
    const [old, current] =
      field === undefined ? [undefined, undefined] : [byName(then, field), byName(now, field)];
    if (old !== undefined && current !== undefined) {
      const names = [...current.keys(), ...[...old.keys()].filter((n) => !current.has(n))];
      for (const name of names) {
        if (ENTRIES_IN_VALUES.has(rule) && (!old.has(name) || !current.has(name))) continue;
        walk(old.get(name), current.get(name), `${rule}[]`, `${shown}[${JSON.stringify(name)}]`);
      }
      if (rule === "lanes") {
        const kept = (from: Map<string, unknown>, other: Map<string, unknown>) =>
          [...from.keys()].filter((n) => other.has(n));
        if (!same(kept(old, current), kept(current, old))) {
          out.push({ at: shown, change: "reordered" });
        }
      }
      return;
    }
    if (field === undefined && isRecord(then) && isRecord(now)) {
      const keys = [
        ...Object.keys(now),
        ...Object.keys(then).filter((k) => !Object.hasOwn(now, k)),
      ];
      for (const key of keys) {
        walk(
          Object.hasOwn(then, key) ? then[key] : undefined,
          Object.hasOwn(now, key) ? now[key] : undefined,
          rule === "" ? key : `${rule}.${key}`,
          shownKey(shown, key),
        );
      }
      return;
    }
    if (!same(then, now)) out.push({ at: shown, change: "changed" });
  };
  try {
    // As a record would hold it: a key whose value is undefined is not there.
    walk(was, JSON.parse(JSON.stringify(after)), "", "");
  } catch {
    // A declaration nested deeper than the stack goes, which only a record
    // written by hand holds.
    return null;
  }
  return out;
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
