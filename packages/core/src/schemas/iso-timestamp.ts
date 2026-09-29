/**
 * Bring a vendor timestamp into the shape basou's schemas accept.
 *
 * From event `0.3.0` (and `0.2.0` for the other durable documents) every
 * timestamp must carry seconds. Adapters read a vendor's `timestamp` string
 * verbatim, so a vendor that started writing `2026-09-16T01:23Z` would produce
 * a document the reader then drops with a `schema_violation` — the trace would
 * be lost, quietly, for a difference that carries no information.
 *
 * This restores the `:00` that a seconds-less value leaves implicit and changes
 * nothing else. The offset is preserved rather than folded to UTC, because
 * `occurred_at` records when the vendor said a thing happened, including the
 * zone it said it in; `Date.prototype.toISOString` would destroy that.
 *
 * It deliberately does NOT accept the lowercase designators or the leap second
 * that RFC 3339 allows. Those are outside what the schema accepts, and
 * normalizing them here would widen the accepted set through the back door
 * rather than through a version. A value this does not recognize is returned
 * unchanged, so the schema stays the single thing that decides what is
 * accepted.
 *
 * Every timestamp basou has been observed to import already carries seconds
 * (226,077 values across both adapters when the narrowing landed), so at the
 * adapters this guards against a vendor changing. At the read boundaries
 * ({@link normalizeEventTimestamps}, {@link normalizeSessionTimestamps}, and
 * the approval store) it repairs values an older basou accepted from a
 * producer and wrote as given.
 */
export function normalizeIsoTimestamp(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  return match === null ? raw : `${match[1]}:00${match[2]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withNormalized(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === "string") out[field] = normalizeIsoTimestamp(value);
  }
  return out;
}

/**
 * Bring a stored event's timestamps into the shape the schema accepts, before
 * the event is parsed.
 *
 * `basou session import` stores the events a producer supplies as given, and
 * before event `0.3.0` the accepted shape let seconds be omitted. Such a line
 * is still on disk wherever a producer wrote one, and without this a reader
 * drops it as a `schema_violation` -- a document an older basou accepted and
 * wrote, lost for a difference that carries no information.
 *
 * Only `occurred_at` and, on `approval_requested`, `expires_at` are touched,
 * only when they are strings, and only by {@link normalizeIsoTimestamp}.
 * Anything else is passed through for the schema to decide. The bytes on disk
 * are not changed, so the hash chain over them still verifies.
 */
export function normalizeEventTimestamps(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const fields =
    raw.type === "approval_requested" ? ["occurred_at", "expires_at"] : ["occurred_at"];
  return withNormalized(raw, fields);
}

/**
 * Bring a stored `session.yaml`'s timestamps into the shape the schema
 * accepts, before it is parsed -- for the reason given on
 * {@link normalizeEventTimestamps}. Without it the whole session is refused:
 * listings skip it, `session show` fails, and `basou verify` reports the
 * unreadable anchor as tampering.
 *
 * Touches `session.started_at`, `session.ended_at` and the `start` / `end` of
 * each `session.metrics.active_intervals` entry, the same way.
 */
export function normalizeSessionTimestamps(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.session)) return raw;
  const session = withNormalized(raw.session, ["started_at", "ended_at"]);
  const metrics = session.metrics;
  if (isRecord(metrics) && Array.isArray(metrics.active_intervals)) {
    session.metrics = {
      ...metrics,
      active_intervals: metrics.active_intervals.map((interval) =>
        isRecord(interval) ? withNormalized(interval, ["start", "end"]) : interval,
      ),
    };
  }
  return { ...raw, session };
}

/**
 * Bring an approval's timestamps into the shape the schema accepts, before it
 * is parsed.
 *
 * This is the boundary §7.3 of `docs/spec/schemas.md` names: basou never
 * WRITES an approval -- they are placed by an outside orchestrator -- so the
 * refused set cannot be enumerated the way the durable formats basou writes
 * can be, and the version that required seconds had to come with a normalizer
 * here. Without it a producer that omits seconds does not merely lose the
 * line: `loadApproval` throws, and neither the orientation nor the report
 * renderer catches it, so one such file takes both commands down; and
 * `approval list` skips it while `approval approve` / `reject` refuse it, so
 * an approval the orientation reports as pending cannot be resolved. Every
 * one of those readers applies this before parsing.
 *
 * Only the three timestamp fields are touched, only when they are strings, and
 * only by {@link normalizeIsoTimestamp} -- which restores an omitted `:00` and
 * changes nothing else. Anything it does not recognize is passed through for
 * the schema to refuse, so this widens no accepted set; it repairs a spelling
 * the accepted set used to admit.
 */
export function normalizeApprovalTimestamps(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  return withNormalized(raw, ["created_at", "expires_at", "resolved_at"]);
}
