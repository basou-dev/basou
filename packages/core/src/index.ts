/**
 * Version of the `@basou/core` package, aligned with `manifest.yaml`'s
 * `basou_version` field as defined in the Basou v0.1 specification.
 */
export const BASOU_CORE_VERSION = "0.1.0";

export type {
  BuildStopHookCommandOptions,
  ClaudeSessionStartHookKind,
  ClaudeSessionStartHookLocation,
  ClaudeSessionStartHookRemoval,
  ClaudeSessionStartHookUpsert,
  ClaudeSettings,
  ClaudeTranscriptRecord,
  ClaudeTranscriptToPayloadOptions,
  ClaudeUnrecognizedSessionStart,
  CommandLookup,
  ReviewGateResult,
  ReviewGateSilentReason,
  StopHookEvaluation,
  StopHookEvaluationInput,
  StopHookRemoval,
  StopHookSilentReason,
  StopHookUpsert,
} from "./adapters/claude-code/index.js";
export {
  buildStopHookCommand,
  CLAUDE_IMPORT_SOURCE,
  claudeCodeAdapterMetadata,
  claudeTranscriptToImportPayload,
  DEFAULT_STOP_HOOK_MIN_EDITS,
  evaluateStopHook,
  findBasouStopHookCommand,
  findClaudeSessionStartHooks,
  findUnrecognizedSessionStart,
  isBasouOrientSessionStartCommand,
  isBasouStopHookCommand,
  isClaudeSessionStartHookCommand,
  isClaudeSessionStartMalformed,
  removeClaudeSessionStartHook,
  removeStopHook,
  resolveClaudeCodeCommand,
  STOP_HOOK_TIMEOUT_SECONDS,
  summarizeAdapterOutput,
  transcriptStartedAt,
  upsertClaudeSessionStartHook,
  upsertStopHook,
} from "./adapters/claude-code/index.js";
export type {
  CodexCommandLookup,
  CodexHooksFile,
  CodexRolloutRecord,
  CodexRolloutToPayloadOptions,
  SessionStartHookLocation,
  SessionStartHookRemoval,
  SessionStartHookUpsert,
} from "./adapters/codex/index.js";
export {
  buildSessionStartHookCommand,
  CODEX_IMPORT_SOURCE,
  codexAdapterMetadata,
  codexRolloutToImportPayload,
  findBasouSessionStartHook,
  isBasouSessionStartHookCommand,
  removeSessionStartHook,
  resolveCodexCommand,
  SESSION_START_HOOK_CONTEXT_LIMIT,
  SESSION_START_HOOK_MATCHER,
  SESSION_START_HOOK_STATUS_MESSAGE,
  SESSION_START_HOOK_TIMEOUT_SECONDS,
  upsertSessionStartHook,
} from "./adapters/codex/index.js";
export type { ApprovalLocation, LoadedApproval } from "./approval/index.js";
export { enumerateApprovals, isLazyExpired, loadApproval } from "./approval/index.js";
export type {
  DecisionGap,
  DecisionGapsExcluded,
  DecisionGapsIncomplete,
  DecisionGapsInput,
  DecisionGapsScope,
  DecisionGapsSummary,
} from "./decision-gaps/index.js";
export { DECISION_GAPS_EPOCH, findDecisionGaps } from "./decision-gaps/index.js";
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
export { getChangesSince, getDiff } from "./git/diff.js";
export type { GitSnapshot } from "./git/snapshot.js";
export {
  getSnapshot,
  isGitNotFound,
  resolveBasouRepositoryRoot,
  resolveRepositoryRoot,
  safeSimpleGit,
  tryRemoteUrl,
} from "./git/snapshot.js";
export { getWorkingTreeChanges, readHeadSha } from "./git/working-tree.js";
export type { HandoffRendererInput, HandoffRendererResult } from "./handoff/index.js";
export { renderHandoff } from "./handoff/index.js";
export type { IdPrefix, PrefixedId } from "./ids/ulid.js";
export { ID_PREFIXES, isValidPrefixedId, prefixedUlid, ulid } from "./ids/ulid.js";
export { BASOU_CORE_BUILD, type BuildStamp, parseBuildStamp } from "./lib/build-stamp.js";
export { displayPath } from "./lib/display-path.js";
export { parseDuration } from "./lib/duration.js";
export { formatDurationMs } from "./lib/format-duration.js";
export { resolveSessionId, resolveTaskId } from "./lib/id-resolver.js";
export type { SanitizePathOptions, SanitizeRelatedFilesResult } from "./lib/path-sanitizer.js";
export {
  sanitizePath,
  sanitizeRelatedFiles,
  sanitizeWorkingDirectory,
} from "./lib/path-sanitizer.js";
export type { SourceRootScope } from "./lib/source-root-scope.js";
export { AGENT_INFRA_DIRS, classifyFilesBySourceRoot } from "./lib/source-root-scope.js";
export type { PresetStrings, ViewLanguage, ViewStrings } from "./lib/view-strings.js";
export {
  presetStrings,
  resolveAnchorContentLanguage,
  resolveRepoContentLanguage,
  resolveViewLanguage,
  resolveViewLanguageFromPaths,
  viewStrings,
} from "./lib/view-strings.js";
export type {
  OrientationRendererInput,
  OrientationRendererResult,
  OrientationSummary,
} from "./orientation/index.js";
export { renderOrientation, summarizeOrientation } from "./orientation/index.js";
export type {
  AnchorStarterInput,
  AnchorStarterRepo,
} from "./project/anchor-starter.js";
export { renderAnchorStarter } from "./project/anchor-starter.js";
export type { ArchivePlan } from "./project/archive.js";
export { planArchive } from "./project/archive.js";
export type {
  GitignorePlanSummary,
  RepoGitignoreFacts,
  RepoGitignorePlan,
} from "./project/gitignore-plan.js";
export { planGitignore } from "./project/gitignore-plan.js";
export type {
  PresetAction,
  PresetCollision,
  PresetMarkerConflict,
  PresetMarkerKind,
  PresetPlanSummary,
  PresetRepo,
  RepoPresetFacts,
  RepoPresetPlan,
  ViewPresetInput,
  ViewPresetRepo,
} from "./project/preset.js";
export {
  isRenderable,
  renderPresetBlock,
  renderViewPresetBlock,
  summarizePresetPlan,
} from "./project/preset.js";
export type { RenamePlan } from "./project/rename.js";
export { pathBasename, planRename } from "./project/rename.js";
export type {
  RetrofitAction,
  RetrofitAgentsState,
  RetrofitFacts,
  RetrofitPlan,
  RetrofitReason,
} from "./project/retrofit.js";
export { classifyRetrofit } from "./project/retrofit.js";
export type {
  AdoptCandidate,
  AdoptCandidateKind,
  PublishKind,
  PublishTarget,
  RepoEntry,
  RepoInstructions,
  RepoLanguage,
  RepoVisibility,
  RosterAdoptionPlan,
  RosterDriftSummary,
  SourceRootsReconcile,
} from "./project/roster.js";
export {
  instructionMode,
  planRosterAdoption,
  reconcileSourceRoots,
  summarizeRosterDrift,
} from "./project/roster.js";
export type {
  InstructionSymlinkFact,
  InstructionSymlinkState,
  RepoSymlinkFacts,
  RepoSymlinkPlan,
  SymlinkCollision,
  SymlinkConflict,
  SymlinkPlanSummary,
} from "./project/symlinks.js";
export { summarizeSymlinkPlan } from "./project/symlinks.js";
export type {
  InstructionFileFact,
  RepoWiringFacts,
  WiringRisk,
  WiringSummary,
} from "./project/wiring.js";
export { summarizeWiring } from "./project/wiring.js";
export type {
  IncompleteWiring,
  MissingCanonical,
  ViewWiringFacts,
  WiringCollision,
  WiringConflict,
  WiringDriftSummary,
} from "./project/wiring-drift.js";
export { summarizeWiringDrift } from "./project/wiring-drift.js";
export type {
  ExistingViewLink,
  ViewCollision,
  ViewConflict,
  ViewLinkState,
  ViewRepoFact,
  ViewStrayUnknown,
  WorkspaceViewPlan,
} from "./project/workspace-view.js";
export { planWorkspaceView } from "./project/workspace-view.js";
export type { ProtocolStamp } from "./protocol/protocol-stamp.js";
export {
  carryForwardProtocolStamp,
  isProtocolUpdateDue,
  PROTOCOL_UPDATE_TOKEN_PREFIX,
  parseProtocolStamp,
  protocolBlockHash,
  protocolSectionsFrom,
  protocolUpdateToken,
  renderProtocolStamp,
  renderProtocolUpdate,
  unstampedProtocolSectionsFrom,
} from "./protocol/protocol-stamp.js";
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
  RepoPathProblem,
  ReviewGapRepoSummary,
  ReviewGapsInput,
  ReviewGapsSummary,
  ReviewGapUnit,
  ReviewGapVerdict,
  ReviewRecordBlockedInput,
  ReviewRecordFindingInput,
  ReviewRecordInput,
  SelfReportedReview,
  UnattachedSelfReports,
  UnbindableRepo,
} from "./review/index.js";
export {
  buildReviewRecordedEvent,
  buildReviewRecordLabel,
  findReviewGaps,
  findUnbindableRepos,
  normalizeRepoKey,
  normalizeRepoPath,
  parseReviewRecordInput,
  REVIEW_RECORD_NO_INPUT_HINT,
  resolveRepoRoot,
} from "./review/index.js";
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
  ReviewBlocked,
  ReviewFinding,
  ReviewRecordedEvent,
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
  APPROVAL_SCHEMA_VERSION,
  ApprovalIdSchema,
  ApprovalSchema,
  ApprovalStatusSchema,
  buildJsonSchemas,
  DecisionIdSchema,
  EVENT_SCHEMA_VERSION,
  EventIdSchema,
  EventSchema,
  EventSourceSchema,
  hasRetiredZeroDuration,
  IsoTimestampSchema,
  JSON_SCHEMA_VERSIONS,
  LOCAL_CLI_EVENT_SOURCE,
  MANIFEST_SCHEMA_VERSION,
  ManifestSchema,
  RiskLevelSchema,
  readObservedDuration,
  SchemaVersionSchema,
  SESSION_IMPORT_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
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
  TASK_SCHEMA_VERSION,
  TaskIdSchema,
  TaskSchema,
  TaskStatusSchema,
  unknownManifestKeys,
  WorkspaceIdSchema,
  writeObservedDuration,
  ZERO_DURATION_RETIRED_SINCE,
} from "./schemas/index.js";
export type {
  ObservedFile,
  ObservedRepo,
  SessionObservation,
} from "./session/observation.js";
export {
  observedFilesOf,
  readSessionObservation,
  SESSION_OBSERVATION_SCHEMA_VERSION,
  sessionObservationPath,
  writeSessionObservation,
} from "./session/observation.js";
export type { ObserveSessionInput } from "./session/observe.js";
export {
  observedRepoRoots,
  observeSessionChanges,
  recordSessionBaseline,
} from "./session/observe.js";
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
  FederatedRoot,
  ImportSessionOptions,
  ImportSessionResult,
  LoadFederatedOptions,
  LoadSessionEntriesOptions,
  LoadTaskEntriesOptions,
  LockHandle,
  LockScope,
  MarkerSection,
  Markers,
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
  loadFederatedSessionEntries,
  loadSessionEntries,
  loadTaskEntries,
  ORIENTATION_END,
  ORIENTATION_START,
  overwriteYamlFile,
  PROTOCOL_END,
  PROTOCOL_START,
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
  removeMarkerSection,
  renderWithMarkers,
  STUCK_THRESHOLD_MS,
  seedMarkers,
  TaskWriteAfterEventError,
  updateTaskStatusWithEvent,
  writeManifest,
  writeMarkdownFile,
  writeStatus,
  writeTaskFile,
  writeYamlFile,
} from "./storage/index.js";
