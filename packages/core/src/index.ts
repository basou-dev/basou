/**
 * Version of the `@basou/core` package, aligned with `manifest.yaml`'s
 * `basou_version` field as defined in the Basou v0.1 specification.
 */
export const BASOU_CORE_VERSION = "0.1.0";

export { ulid, prefixedUlid, isValidPrefixedId, ID_PREFIXES } from "./ids/ulid.js";
export type { IdPrefix, PrefixedId } from "./ids/ulid.js";

export {
  WorkspaceIdSchema,
  TaskIdSchema,
  SessionIdSchema,
  EventIdSchema,
  ApprovalIdSchema,
  DecisionIdSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
  RiskLevelSchema,
  EventSourceSchema,
  ManifestSchema,
  SessionSchema,
  SessionStatusSchema,
  SessionSourceKindSchema,
  EventSchema,
  StatusSchema,
  ApprovalSchema,
  ApprovalStatusSchema,
} from "./schemas/index.js";
export type {
  RiskLevel,
  Manifest,
  Session,
  SessionStatus,
  Event,
  SessionStartedEvent,
  SessionEndedEvent,
  SessionStatusChangedEvent,
  ApprovalRequestedEvent,
  ApprovalApprovedEvent,
  ApprovalRejectedEvent,
  ApprovalExpiredEvent,
  CommandExecutedEvent,
  GitSnapshotEvent,
  FileChangedEvent,
  DecisionRecordedEvent,
  TaskCreatedEvent,
  TaskStatusChangedEvent,
  NoteAddedEvent,
  AdapterOutputEvent,
  StatusSnapshot,
  Approval,
  ApprovalStatus,
} from "./schemas/index.js";

export { enumerateApprovals, isLazyExpired, loadApproval } from "./approval/index.js";
export type { ApprovalLocation, LoadedApproval } from "./approval/index.js";

export {
  appendBasouGitignore,
  assertBasouRootSafe,
  basouPaths,
  buildStatusSnapshot,
  classifySuspect,
  createManifest,
  enumerateSessionDirs,
  ensureBasouDirectory,
  findErrorCode,
  GENERATED_END,
  GENERATED_START,
  linkYamlFile,
  loadSessionEntries,
  overwriteYamlFile,
  parseMarkers,
  readManifest,
  readMarkdownFile,
  readSessionYaml,
  readStatus,
  readYamlFile,
  renderWithMarkers,
  STUCK_THRESHOLD_MS,
  writeManifest,
  writeMarkdownFile,
  writeStatus,
  writeYamlFile,
} from "./storage/index.js";
export type {
  AppendBasouGitignoreResult,
  BasouPaths,
  CreateManifestInput,
  LoadSessionEntriesOptions,
  MarkerSection,
  SessionEntry,
  SessionSkipReason,
  SuspectReason,
} from "./storage/index.js";

export { renderHandoff } from "./handoff/index.js";
export type { HandoffRendererInput, HandoffRendererResult } from "./handoff/index.js";

export { renderDecisions } from "./decisions/index.js";
export type { DecisionsRendererInput, DecisionsRendererResult } from "./decisions/index.js";

export { ChildProcessRunner } from "./runtime/child-process-runner.js";
export type {
  CaptureMode,
  ProcessRunner,
  RunOptions,
  RunResult,
} from "./runtime/process-runner.js";

export { getSnapshot, resolveRepositoryRoot, tryRemoteUrl } from "./git/snapshot.js";
export type { GitSnapshot } from "./git/snapshot.js";

export { getDiff } from "./git/diff.js";
export type { DiffResult, FileChange, FileChangeStatus } from "./git/diff.js";

export {
  claudeCodeAdapterMetadata,
  resolveClaudeCodeCommand,
  summarizeAdapterOutput,
} from "./adapters/claude-code/index.js";
export type { CommandLookup } from "./adapters/claude-code/index.js";

export { appendEvent, readAllEvents, replayEvents } from "./events/index.js";
export type { ReplayOptions, ReplayWarning } from "./events/index.js";

export { parseDuration } from "./lib/duration.js";
