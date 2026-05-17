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
  TaskSchema,
  TaskStatusSchema,
  EventSchema,
  StatusSchema,
  ApprovalSchema,
  ApprovalStatusSchema,
  SessionImportPayloadSchema,
  SessionInnerImportSchema,
} from "./schemas/index.js";
export type {
  RiskLevel,
  Manifest,
  Session,
  SessionStatus,
  SessionSourceKind,
  Task,
  TaskStatus,
  SessionImportPayload,
  SessionInnerImportInput,
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
  TaskReconciledEvent,
  TaskLinkageRefreshedEvent,
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
  appendEventToExistingSession,
  assertBasouRootSafe,
  basouPaths,
  buildStatusSnapshot,
  classifySuspect,
  createAdHocSessionWithEvent,
  createManifest,
  createTaskWithEvent,
  enumerateSessionDirs,
  enumerateTaskIds,
  ensureBasouDirectory,
  FailedToFinalizeError,
  findErrorCode,
  GENERATED_END,
  GENERATED_START,
  importSessionFromJson,
  linkYamlFile,
  loadSessionEntries,
  loadTaskEntries,
  overwriteYamlFile,
  parseMarkers,
  readManifest,
  readMarkdownFile,
  readSessionYaml,
  readStatus,
  readTaskFile,
  readYamlFile,
  reconcileAllTasks,
  reconcileTask,
  refreshTaskLinkedSessions,
  renderWithMarkers,
  STUCK_THRESHOLD_MS,
  TaskWriteAfterEventError,
  updateTaskStatusWithEvent,
  writeManifest,
  writeMarkdownFile,
  writeStatus,
  writeTaskFile,
  writeYamlFile,
} from "./storage/index.js";
export type {
  AppendBasouGitignoreResult,
  AppendEventToExistingInput,
  AppendEventToExistingResult,
  AttachableStatus,
  AttachTaskInput,
  AttachUpdateTaskStatusInput,
  BasouPaths,
  CreateAdHocSessionInput,
  CreateAdHocSessionResult,
  CreateAdHocTaskInput,
  CreateManifestInput,
  CreateTaskInput,
  CreateTaskResult,
  ImportSessionOptions,
  ImportSessionResult,
  LoadSessionEntriesOptions,
  LoadTaskEntriesOptions,
  MarkerSection,
  ReconcileAllResult,
  ReconcileAllTasksInput,
  ReconcileAllTasksOptions,
  ReconcileFailure,
  ReconcileResult,
  ReconcileTaskInput,
  RefreshLinkageInput,
  RefreshLinkageResult,
  SessionEntry,
  SessionSkipReason,
  SuspectReason,
  TaskDocument,
  TaskSkipReason,
  TaskWriteAfterEventPhase,
  UpdateAdHocTaskStatusInput,
  UpdateTaskStatusInput,
  UpdateTaskStatusResult,
  WriteTaskFileMode,
} from "./storage/index.js";

export { resolveSessionId, resolveTaskId } from "./lib/id-resolver.js";

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

export { appendEvent, readAllEvents, replayEvents, writeEventsBulk } from "./events/index.js";
export type { ReplayOptions, ReplayWarning } from "./events/index.js";

export { parseDuration } from "./lib/duration.js";
