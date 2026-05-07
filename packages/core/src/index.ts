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
} from "./schemas/index.js";

export {
  appendBasouGitignore,
  assertBasouRootSafe,
  basouPaths,
  buildStatusSnapshot,
  createManifest,
  ensureBasouDirectory,
  findErrorCode,
  readManifest,
  readStatus,
  readYamlFile,
  writeManifest,
  writeStatus,
  writeYamlFile,
} from "./storage/index.js";
export type {
  AppendBasouGitignoreResult,
  BasouPaths,
  CreateManifestInput,
} from "./storage/index.js";

export { ChildProcessRunner } from "./runtime/child-process-runner.js";
export type {
  ProcessRunner,
  RunOptions,
  RunResult,
} from "./runtime/process-runner.js";

export { getSnapshot, resolveRepositoryRoot, tryRemoteUrl } from "./git/snapshot.js";
export type { GitSnapshot } from "./git/snapshot.js";
