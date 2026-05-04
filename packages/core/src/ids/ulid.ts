import { isValid as isValidUlid, monotonicFactory } from "ulid";

/**
 * Allowed ID type prefixes for Basou entities.
 *
 * Frozen at runtime so that mutating the exported array cannot diverge from
 * the validation set used internally. The single source of truth for both
 * the `IdPrefix` type and runtime prefix checks.
 */
export const ID_PREFIXES = Object.freeze(["ws", "task", "ses", "evt", "appr", "decision"] as const);

/**
 * Type prefix used for Basou entity IDs.
 * Format: `<prefix>_<26-char ULID>`, e.g. `ws_01HXABCDEF1234567890ABCDEF`.
 */
export type IdPrefix = (typeof ID_PREFIXES)[number];

/**
 * A Basou entity ID as a template literal type.
 *
 * `PrefixedId<"ses">` narrows to ``ses_${string}`` so a session schema can
 * preserve the prefix in its inferred type beyond runtime validation.
 */
export type PrefixedId<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const PREFIX_SET = new Set<string>(ID_PREFIXES);

// ULID body shape: 26 chars, first char 0-7 (48-bit timestamp / 5-bit Crockford
// symbols), remaining 25 chars use Crockford alphabet excluding I, L, O, U.
// Enforced locally because npm `ulid`'s `isValid` does not reject leading 8 or 9.
const ULID_BODY_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

// Module-scope monotonic factory. Created once at module load. Pure function
// so it does not violate `sideEffects: false` of the surrounding package.
const monotonic = monotonicFactory();

/**
 * Generate a Crockford Base32 ULID.
 *
 * The result is a 26-character, lexicographically time-sortable identifier.
 * Multiple calls within the same millisecond are strictly increasing for the
 * lifetime of the current process.
 *
 * NOTE: `seedTime` is forwarded to the underlying monotonic factory and is
 * NOT a deterministic seed: repeated calls with the same `seedTime` still
 * return strictly increasing values, because the factory increments its
 * internal counter on each call.
 *
 * @param seedTime Optional millisecond timestamp passed to the monotonic
 *   factory. Useful for ordered generation in tests; not deterministic.
 */
export function ulid(seedTime?: number): string {
  return monotonic(seedTime);
}

/**
 * Generate a prefixed Basou ID, e.g. `ses_01HXABCDEF1234567890ABCDEF`.
 *
 * The return type preserves the prefix as a template literal type so that
 * downstream zod schemas can narrow an `IdPrefix` parameter through the API.
 *
 * Throws if `prefix` is not one of {@link ID_PREFIXES}. The runtime guard
 * defends against JavaScript callers and casted TypeScript that bypass the
 * compile-time `IdPrefix` constraint.
 */
export function prefixedUlid<P extends IdPrefix>(prefix: P): PrefixedId<P> {
  if (!PREFIX_SET.has(prefix)) {
    throw new Error(`Unknown ID prefix: ${prefix}`);
  }
  return `${prefix}_${ulid()}` as PrefixedId<P>;
}

/**
 * Check whether the given string is a valid prefixed Basou ID.
 *
 * Returns true only if the string has shape `<prefix>_<ULID>` where prefix is
 * one of {@link ID_PREFIXES} and the trailing 26 characters form a valid
 * Crockford Base32 ULID. Validation combines a strict shape regex (to enforce
 * the 0-7 leading char and the I/L/O/U exclusion) with the npm `ulid`
 * library's `isValid` for forward compatibility.
 *
 * NOTE: This validates the prefix is known. Schemas that require a specific
 * prefix (e.g. only `ses_*` for a session ID) must add their own narrowing.
 */
export function isValidPrefixedId(value: string): boolean {
  const idx = value.indexOf("_");
  if (idx <= 0) return false;
  const prefix = value.slice(0, idx);
  const ulidPart = value.slice(idx + 1);
  if (!PREFIX_SET.has(prefix)) return false;
  if (!ULID_BODY_REGEX.test(ulidPart)) return false;
  return isValidUlid(ulidPart);
}
