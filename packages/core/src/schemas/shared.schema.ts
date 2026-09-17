import { z } from "zod";
import { type IdPrefix, isValidPrefixedId, type PrefixedId } from "../ids/ulid.js";

/**
 * The `.basou` on-disk format version, of the form `MAJOR.MINOR.PATCH`.
 *
 * This basou reads format **major 0**: it accepts any `0.x.y` (a newer MINOR /
 * PATCH is additive and still parses, because the entity schemas are loose and
 * preserve unknown fields) and GATES a higher / unknown major with an explicit
 * "upgrade basou" error rather than a cryptic field-level parse failure. The
 * gate behavior is part of the frozen format contract, so it is defined before
 * the semver-1.0 freeze — it cannot be retrofitted onto a frozen `z.literal`.
 *
 * The format major is DECOUPLED from the npm / product version: shipping basou
 * product 1.0.0 does not bump this major — it stays `0` until the on-disk format
 * itself changes incompatibly. The regex (not a `.refine`) is the gate so it is
 * emitted faithfully into the published JSON Schema `pattern`, letting a
 * cross-language validator enforce the same major.
 */
export const SchemaVersionSchema = z.string().regex(/^0\.\d+\.\d+$/, {
  message:
    "unsupported .basou format version: this basou reads format major 0 (0.x.y). If this workspace was written by a newer basou, upgrade basou to open it.",
});

/**
 * Version stamp for a REBUILDABLE cache file (`status.json`, `tasks/index.json`)
 * — pinned to the exact literal, NOT the forward-compatible format gate. A cache
 * is regenerated from the durable events on any mismatch, so its reader wants an
 * exact-match-or-rebuild policy (a higher minor is a "rebuild", not "accept and
 * preserve"). Keeping caches on a literal also keeps the published cache JSON
 * Schema (`const`) faithful to that runtime behavior. Durable, forward-compatible
 * fields use {@link SchemaVersionSchema} instead.
 */
export const CacheVersionSchema = z.literal("0.1.0");

/**
 * The accepted shape of an ISO 8601 timestamp, owned by basou rather than by
 * whichever zod is installed.
 *
 * Seconds are required, and an offset (e.g. `+09:00`) or `Z` is required
 * because the spec samples carry offsets and the default zod `.datetime()`
 * rejects them. The expression began as the one zod emitted for
 * `.datetime({ offset: true })` when these artifacts were first published,
 * pinned here as a literal; requiring seconds is the one deliberate departure
 * from it.
 *
 * It is pinned because the published JSON Schema artifacts describe it under a
 * `$id` that does not move: zod 4.6 narrowed its own ISO expression to require
 * seconds, which would have shrunk what an already-published artifact accepts
 * without any version signal. `docs/spec/schemas.md` forbids narrowing a
 * domain, so a dependency's minor release must not be able to do it. Widening
 * or narrowing this constant is a change to the event format itself and is
 * gated by the rules in that document.
 */
const ISO_TIMESTAMP_PATTERN =
  "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$";

const isoTimestampRegex = new RegExp(ISO_TIMESTAMP_PATTERN);

/**
 * ISO 8601 timestamp with explicit timezone offset (e.g. `+09:00`).
 *
 * The gate is `.regex`, not a `.refine`: zod emits a regex check as the
 * artifact's `pattern`, so there is one expression rather than a runtime check
 * and a `.meta` restating it. A `.refine` is opaque to JSON Schema generation
 * and would need the pattern written a second time, which is a second place to
 * forget. {@link SchemaVersionSchema} takes the same form for the same reason.
 *
 * It deliberately does NOT declare `format: "date-time"`. That format names
 * RFC 3339, and the two sets cross rather than nest: basou takes a timestamp
 * without seconds, which RFC 3339 does not, and refuses the lowercase
 * designators and the leap second that RFC 3339 allows. Declaring the format
 * made one artifact answer two ways from the same bytes — a validator
 * asserting it rejected `2026-09-16T01:23Z`, one treating it as an annotation
 * (the JSON Schema 2020-12 default) accepted it. The `pattern` is the
 * contract, and `description` says so, because no format name states this set.
 */
export const IsoTimestampSchema = z
  .string()
  .regex(isoTimestampRegex, "Expected an ISO 8601 timestamp with a timezone offset")
  .meta({
    description:
      "Timestamp with an offset or Z. The pattern is normative under ECMA-262 semantics: RFC 3339 date-time with uppercase designators, no leap second, and optional seconds.",
  });

// Internal factory shared by every prefixed-ID schema. Not exported because
// the public API surface should only expose the six fully-typed ID schemas.
//
// The `.refine` carries the real (ULID-aware) validation but is opaque to JSON
// Schema generation, so the `.meta` mirrors the prefix + ULID-body shape as a
// representable `pattern` (and a description). This is METADATA ONLY: it does
// not affect parsing — `isValidPrefixedId` still gates acceptance — it just
// lets `z.toJSONSchema` emit a faithful pattern for the published artifact. The
// pattern mirrors `ULID_BODY_REGEX` (leading 0-7, then 25 Crockford symbols
// excluding I/L/O/U); it is intentionally slightly looser than the library
// `isValid` check, matching the documented id shape.
const createPrefixedIdSchema = <P extends IdPrefix>(prefix: P) => {
  const refiner = (value: string): value is PrefixedId<P> =>
    isValidPrefixedId(value) && value.startsWith(`${prefix}_`);
  return z
    .string()
    .refine(refiner, { message: `Expected ${prefix}_<ULID>` })
    .meta({
      pattern: `^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`,
      description: `Basou ${prefix} id: \`${prefix}_\` followed by a 26-character Crockford Base32 ULID.`,
    });
};

/** Workspace ID schema: validates `ws_<26-char ULID>`. */
export const WorkspaceIdSchema = createPrefixedIdSchema("ws");
/** Task ID schema: validates `task_<26-char ULID>`. */
export const TaskIdSchema = createPrefixedIdSchema("task");
/** Session ID schema: validates `ses_<26-char ULID>`. */
export const SessionIdSchema = createPrefixedIdSchema("ses");
/** Event ID schema: validates `evt_<26-char ULID>`. */
export const EventIdSchema = createPrefixedIdSchema("evt");
/** Approval ID schema: validates `appr_<26-char ULID>`. */
export const ApprovalIdSchema = createPrefixedIdSchema("appr");
/** Decision ID schema: validates `decision_<26-char ULID>`. */
export const DecisionIdSchema = createPrefixedIdSchema("decision");

/**
 * Risk level vocabulary fixed by the spec. Adapters MUST emit one of these
 * four values; arbitrary strings are rejected at schema parse time.
 */
export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
/** Inferred runtime type for {@link RiskLevelSchema}. */
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/**
 * Source attribution for events (e.g. "claude-code-adapter",
 * "git-capability", "terminal-recording", "local-cli", "human"). Free-form
 * non-empty string in v0.1; a stricter enum may be introduced post-v0.1.
 */
export const EventSourceSchema = z.string().min(1);
