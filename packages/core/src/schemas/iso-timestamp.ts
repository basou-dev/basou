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
 * (226,077 values across both adapters when the narrowing landed), so this
 * guards against a vendor changing rather than transforming anything that is
 * on disk today.
 */
export function normalizeIsoTimestamp(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  return match === null ? raw : `${match[1]}:00${match[2]}`;
}
