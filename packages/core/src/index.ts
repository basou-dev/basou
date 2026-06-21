/**
 * Version of the `@basou/core` package, aligned with `manifest.yaml`'s
 * `basou_version` field as defined in the Basou v0.1 specification.
 */
export const BASOU_CORE_VERSION = "0.1.0";

export type {
  ClaudeTranscriptRecord,
  ClaudeTranscriptToPayloadOptions,
  CommandLookup,
} from "./adapters/claude-code/index.js";
export {
  CLAUDE_IMPORT_SOURCE,
  claudeCodeAdapterMetadata,
  claudeTranscriptToImportPayload,
  resolveClaudeCodeCommand,
  summarizeAdapterOutput,
} from "./adapters/claude-code/index.js";
export type {
  CodexRolloutRecord,
  CodexRolloutToPayloadOptions,
} from "./adapters/codex/index.js";
export { CODEX_IMPORT_SOURCE, codexRolloutToImportPayload } from "./adapters/codex/index.js";
export type { ApprovalLocation, LoadedApproval } from "./approval/index.js";
export { enumerateApprovals, isLazyExpired, loadApproval } from "./approval/index.js";
export type { DecisionsRendererInput, DecisionsRendererResult } from "./decisions/index.js";
export { renderDecisions } from "./decisions/index.js";
export type {
  BulkChainResult,
  ChainBreakReason,
  ChainedEvents,
  ChainTailState,
  ChainVerdict,
  ChainVerdictStatus,
  ReplayOptions,
  ReplayWarning,
  WriteEventsBulkOptions,
} from "./events/index.js";
export {
  appendChainedEvent,
  appendChainedEventLocked,
  appendEvent,
  chainEvents,
  chainRawJsonLines,
  genesisHash,
  inspectChainTail,
  lineHash,
  readAllEvents,
  replayEvents,
  serializeEventLine,
  verifyEventsChain,
  writeEventsBulk,
} from "./events/index.js";
export type { DiffResult, FileChange, FileChangeStatus } from "./git/diff.js";
export { getDiff } from "./git/diff.js";
export type { GitSnapshot } from "./git/snapshot.js";
export {
  getSnapshot,
  resolveBasouRepositoryRoot,
  resolveRepositoryRoot,
  tryRemoteUrl,
} from "./git/snapshot.js";
export type { HandoffRendererInput, HandoffRendererResult } from "./handoff/index.js";
export { renderHandoff } from "./handoff/index.js";
export type { IdPrefix, PrefixedId } from "./ids/ulid.js";
export { ID_PREFIXES, isValidPrefixedId, prefixedUlid, ulid } from "./ids/ulid.js";
export { parseDuration } from "./lib/duration.js";
export { formatDurationMs } from "./lib/format-duration.js";
export { resolveSessionId, resolveTaskId } from "./lib/id-resolver.js";
export type { SanitizePathOptions, SanitizeRelatedFilesResult } from "./lib/path-sanitizer.js";
export {
  sanitizePath,
  sanitizeRelatedFiles,
  sanitizeWorkingDirectory,
} from "./lib/path-sanitizer.js";
export type {
  OrientationRendererInput,
  OrientationRendererResult,
  OrientationSummary,
} from "./orientation/index.js";
export { renderOrientation, summarizeOrientation } from "./orientation/index.js";
export type {
  AdoptCandidate,
  AdoptCandidateKind,
  RepoEntry,
  RepoVisibility,
  RosterAdoptionPlan,
  RosterDriftSummary,
  SourceRootsReconcile,
} from "./project/roster.js";
export {
  planRosterAdoption,
  reconcileSourceRoots,
  summarizeRosterDrift,
} from "./project/roster.js";
export type {
  ReportApprovalItem,
  ReportData,
  ReportDecisionItem,
  ReportRendererInput,
  ReportRendererResult,
  ReportSessionItem,
  ReportTaskItem,
  TaskStatusCount,
} from "./report/index.js";
export { renderReport } from "./report/index.js";
export type {
  CitedReview,
  ReviewGapRepoSummary,
  ReviewGapsInput,
  ReviewGapsSummary,
  ReviewGapUnit,
  ReviewGapVerdict,
} from "./review/index.js";
export { findReviewGaps, normalizeRepoKey, normalizeRepoPath } from "./review/index.js";
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
  JsonSchemaArtifact,
  Manifest,
  NoteAddedEvent,
  RiskLevel,
  Session,
  SessionEndedEvent,
  SessionImportPayload,
  SessionInnerImportInput,
  SessionIntegrity,
  SessionMetrics,
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
  buildJsonSchemas,
  DecisionIdSchema,
  EventIdSchema,
  EventSchema,
  EventSourceSchema,
  IsoTimestampSchema,
  JSON_SCHEMA_VERSION,
  ManifestSchema,
  RiskLevelSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  SessionImportPayloadSchema,
  SessionInnerImportSchema,
  SessionIntegritySchema,
  SessionMetricsSchema,
  SessionSchema,
  SessionSourceKindSchema,
  SessionStatusSchema,
  StatusSchema,
  serializeJsonSchema,
  TaskIdSchema,
  TaskSchema,
  TaskStatusSchema,
  WorkspaceIdSchema,
} from "./schemas/index.js";
export type {
  ActiveTimeBasis,
  DayWorkStats,
  MeasureAvailability,
  SessionWorkStats,
  SourceWorkStats,
  StatusCount,
  TokenTotals,
  WorkStatsInput,
  WorkStatsResult,
  WorkStatsTotals,
} from "./stats/index.js";
export { ACTIVE_GAP_CAP_MS, computeWorkStats, sessionWorkStatsFromEvents } from "./stats/index.js";
export type {
  AppendBasouGitignoreOptions,
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
  RechainOptions,
  RechainResult,
  ReconcileAllResult,
  ReconcileAllTasksInput,
  ReconcileAllTasksOptions,
  ReconcileFailure,
  ReconcileResult,
  ReconcileTaskInput,
  RefreshLinkageInput,
  RefreshLinkageResult,
  ReimportOptions,
  ReimportResult,
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
  finalizeSessionYaml,
  findErrorCode,
  GENERATED_END,
  GENERATED_START,
  importSessionFromJson,
  isImportDerivedSource,
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
  rechainSessionInPlace,
  reconcileAllTasks,
  reconcileTask,
  refreshTaskLinkedSessions,
  reimportPreservingId,
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
