import { z } from "zod";
import { type IdPrefix, type PrefixedId, isValidPrefixedId } from "../ids/ulid.js";

/**
 * Schema version literal pinned to "0.1.0" for Basou v0.1.
 * Reused across every entity schema so inferred types narrow to the literal.
 */
export const SchemaVersionSchema = z.literal("0.1.0");

/**
 * ISO 8601 timestamp with explicit timezone offset (e.g. `+09:00`).
 *
 * Y-2 specification samples include offsets, so the default zod `.datetime()`
 * (which rejects offsets) is insufficient; `{ offset: true }` is required.
 */
export const IsoTimestampSchema = z.string().datetime({ offset: true });

// Internal factory shared by every prefixed-ID schema. Not exported because
// the public API surface should only expose the six fully-typed ID schemas.
const createPrefixedIdSchema = <P extends IdPrefix>(prefix: P) => {
  const refiner = (value: string): value is PrefixedId<P> =>
    isValidPrefixedId(value) && value.startsWith(`${prefix}_`);
  return z.string().refine(refiner, { message: `Expected ${prefix}_<ULID>` });
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
 * Risk level vocabulary fixed by Y-2 Section 9.4. Adapters MUST emit one of
 * these four values; arbitrary strings are rejected at schema parse time.
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
