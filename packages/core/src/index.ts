/**
 * Version of the `@basou/core` package, aligned with `manifest.yaml`'s
 * `basou_version` field as defined in the Basou v0.1 specification.
 */
export const BASOU_CORE_VERSION = "0.1.0";

export { ulid, prefixedUlid, isValidPrefixedId, ID_PREFIXES } from "./ids/ulid.js";
export type { IdPrefix, PrefixedId } from "./ids/ulid.js";
