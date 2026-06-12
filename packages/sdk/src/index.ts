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
 * `0.1.0` was types-only.
 */
export const BASOU_SDK_VERSION = "0.3.0";

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
