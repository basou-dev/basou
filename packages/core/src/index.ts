/**
 * Version of the `@basou/core` package, aligned with `manifest.yaml`'s
 * `basou_version` field as defined in the Basou v0.1 specification.
 */
export const BASOU_CORE_VERSION = "0.1.0";

export type { CommandLookup } from "./adapters/claude-code/index.js";
export {
  claudeCodeAdapterMetadata,
  resolveClaudeCodeCommand,
  summarizeAdapterOutput,
} from "./adapters/claude-code/index.js";
export type { ApprovalLocation, LoadedApproval } from "./approval/index.js";
export { enumerateApprovals, isLazyExpired, loadApproval } from "./approval/index.js";
export type { DecisionsRendererInput, DecisionsRendererResult } from "./decisions/index.js";
export { renderDecisions } from "./decisions/index.js";
export type { ReplayOptions, ReplayWarning } from "./events/index.js";
export { appendEvent, readAllEvents, replayEvents, writeEventsBulk } from "./events/index.js";
export type { DiffResult, FileChange, FileChangeStatus } from "./git/diff.js";
export { getDiff } from "./git/diff.js";
export type { GitSnapshot } from "./git/snapshot.js";
export { getSnapshot, resolveRepositoryRoot, tryRemoteUrl } from "./git/snapshot.js";
export type { HandoffRendererInput, HandoffRendererResult } from "./handoff/index.js";
export { renderHandoff } from "./handoff/index.js";
export type { IdPrefix, PrefixedId } from "./ids/ulid.js";
export { ID_PREFIXES, isValidPrefixedId, prefixedUlid, ulid } from "./ids/ulid.js";
export { parseDuration } from "./lib/duration.js";
export { resolveSessionId, resolveTaskId } from "./lib/id-resolver.js";
export type { SanitizePathOptions, SanitizeRelatedFilesResult } from "./lib/path-sanitizer.js";
export {
  sanitizePath,
  sanitizeRelatedFiles,
  sanitizeWorkingDirectory,
} from "./lib/path-sanitizer.js";
export { ChildProcessRunner } from "./runtime/child-process-runner.js";
export type {
  CaptureMode,
  ProcessRunner,
  RunOptions,
  RunResult,
} from "./runtime/process-runner.js";
export type {
  AdapterOutputEvent,
  Approval,
  ApprovalApprovedEvent,
  ApprovalExpiredEvent,
  ApprovalRejectedEvent,
  ApprovalRequestedEvent,
  ApprovalStatus,
  CommandExecutedEvent,
  DecisionRecordedEvent,
  Event,
  FileChangedEvent,
  GitSnapshotEvent,
  Manifest,
  NoteAddedEvent,
  RiskLevel,
  Session,
  SessionEndedEvent,
  SessionImportPayload,
  SessionInnerImportInput,
  SessionSourceKind,
  SessionStartedEvent,
  SessionStatus,
  SessionStatusChangedEvent,
  StatusSnapshot,
  Task,
  TaskArchivedEvent,
  TaskCreatedEvent,
  TaskDeletedEvent,
  TaskLinkageRefreshedEvent,
  TaskReconciledEvent,
  TaskStatus,
  TaskStatusChangedEvent,
} from "./schemas/index.js";
export {
  ApprovalIdSchema,
  ApprovalSchema,
  ApprovalStatusSchema,
  DecisionIdSchema,
  EventIdSchema,
  EventSchema,
  EventSourceSchema,
  IsoTimestampSchema,
  ManifestSchema,
  RiskLevelSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  SessionImportPayloadSchema,
  SessionInnerImportSchema,
  SessionSchema,
  SessionSourceKindSchema,
  SessionStatusSchema,
  StatusSchema,
  TaskIdSchema,
  TaskSchema,
  TaskStatusSchema,
  WorkspaceIdSchema,
} from "./schemas/index.js";
export type {
  AppendBasouGitignoreResult,
  AppendEventToExistingInput,
  AppendEventToExistingResult,
  ArchiveTaskInput,
  ArchiveTaskResult,
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
  DeleteTaskInput,
  DeleteTaskResult,
  EditTaskInput,
  EditTaskResult,
  ImportSessionOptions,
  ImportSessionResult,
  LoadSessionEntriesOptions,
  LoadTaskEntriesOptions,
  LockHandle,
  LockScope,
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
export {
  acquireLock,
  appendBasouGitignore,
  appendEventToExistingSession,
  archiveTask,
  assertBasouRootSafe,
  basouPaths,
  buildStatusSnapshot,
  classifySuspect,
  createAdHocSessionWithEvent,
  createManifest,
  createTaskWithEvent,
  deleteTask,
  editTask,
  ensureBasouDirectory,
  enumerateArchivedTaskIds,
  enumerateSessionDirs,
  enumerateTaskIds,
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
  readTaskFileWithArchiveFallback,
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
