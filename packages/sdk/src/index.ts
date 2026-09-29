export { BASOU_SDK_BUILD, type BuildStamp, parseBuildStamp } from "./build-stamp.js";
/**
 * `@basou/sdk` — the stable, read-only programmatic API for reading a Basou
 * workspace's provenance (`.basou/`). It is a thin, ergonomic facade over
 * `@basou/core`'s readers: open a workspace once and query sessions, events,
 * tasks, approvals, status, stats, and the rendered handoff / decisions. No
 * writers are exposed — third-party tooling can read provenance without any
 * risk of mutating it.
 *
 * @example
 * ```ts
 * import { openWorkspace, resolveWorkspaceRoot } from "@basou/sdk";
 *
 * const root = await resolveWorkspaceRoot(process.cwd()); // or pass a known root
 * const ws = await openWorkspace(root);
 * for (const { session, suspect } of await ws.listSessions()) {
 *   console.log(session.session.id, session.session.status, suspect);
 * }
 * const stats = await ws.stats();
 * console.log(stats.totals.billableActiveTimeMs);
 * ```
 */

/**
 * SDK API version, tracking the Basou SDK surface (not the npm package
 * version, which moves in lockstep with the monorepo). `0.2.0` was the first
 * release with a runtime read API; `0.3.0` adds `Workspace.renderReport`;
 * `0.4.0` re-exports `readObservedDuration` and carries the `duration_ms`
 * nullability through the re-exported `CommandExecutedEvent`; `0.5.0`
 * re-exports `normalizeIsoTimestamp`, the read rule for a stored timestamp
 * without seconds; `0.1.0` was types-only.
 */
export const BASOU_SDK_VERSION = "0.5.0";

// Read types re-exported from @basou/core so consumers can type the values the
// SDK returns without depending on @basou/core directly. These track the
// on-disk provenance schema.
export type {
  ActiveTimeBasis,
  Approval,
  ApprovalStatus,
  CommandExecutedEvent,
  DayWorkStats,
  DecisionRecordedEvent,
  Event,
  FileChangedEvent,
  LoadedApproval,
  Manifest,
  MeasureAvailability,
  NoteAddedEvent,
  RiskLevel,
  Session,
  SessionEndedEvent,
  SessionEntry,
  SessionMetrics,
  SessionSourceKind,
  SessionStartedEvent,
  SessionStatus,
  SessionStatusChangedEvent,
  SessionWorkStats,
  SourceWorkStats,
  StatusCount,
  StatusSnapshot,
  SuspectReason,
  Task,
  TaskDocument,
  TaskStatus,
  TokenTotals,
  WorkStatsResult,
  WorkStatsTotals,
} from "@basou/core";
/**
 * Read rules re-exported from `@basou/core`, so a consumer of this facade can
 * apply them without depending on core directly.
 *
 * - `readObservedDuration` is the rule for `command_executed.duration_ms`. The
 *   field is `number | null` and a stored `0` also means "not observed", so
 *   reading it off the event is wrong on both counts; this returns the
 *   duration that was actually observed, or null.
 * - `normalizeIsoTimestamp` is the rule for a stored timestamp without
 *   seconds: `2026-09-16T01:23Z` is read as `2026-09-16T01:23:00Z`, with its
 *   offset kept. An older basou accepted such values from a producer and wrote
 *   them as given. The readers behind this facade already apply it, so it is
 *   needed only by a consumer that reads the store's files itself.
 */
export { normalizeIsoTimestamp, readObservedDuration } from "@basou/core";
export { AmbiguousIdError, BasouSdkError, WorkspaceNotFoundError } from "./errors.js";
export {
  openWorkspace,
  type ReportOptions,
  resolveWorkspaceRoot,
  type StatsOptions,
  type Workspace,
  type WorkspaceDiagnostic,
  type WorkspaceOptions,
} from "./workspace.js";
