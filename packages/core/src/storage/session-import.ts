import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeEventsBulk } from "../events/event-writer.js";
import { type PrefixedId, prefixedUlid } from "../ids/ulid.js";
import { findErrorCode } from "../lib/error-codes.js";
import { sanitizeRelatedFiles, sanitizeWorkingDirectory } from "../lib/path-sanitizer.js";
import type { Event } from "../schemas/event.schema.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import type { Session, SessionSourceKind, SessionStatus } from "../schemas/session.schema.js";
import type {
  SessionImportPayload,
  SessionInnerImportInput,
} from "../schemas/session-import.schema.js";
import { TaskIdSchema } from "../schemas/shared.schema.js";
import type { BasouPaths } from "./basou-dir.js";
import { enumerateTaskIds } from "./tasks.js";
import { linkYamlFile } from "./yaml-store.js";

/**
 * Options for {@link importSessionFromJson}. All fields are optional.
 *
 * - `labelOverride` / `taskIdOverride` come from the CLI `--label` / `--task`
 *   flags and win over the corresponding fields on the input payload.
 * - `dryRun` skips disk writes entirely and returns a preview result.
 */
export type ImportSessionOptions = {
  labelOverride?: string;
  taskIdOverride?: string;
  dryRun?: boolean;
};

/**
 * Result of a successful import. `finalStatus` is always the literal
 * `"imported"` (per the import-session lifecycle policy); `finalSourceKind`
 * mirrors the input's `session.source.kind` so round-trip imports preserve
 * provenance.
 *
 * `pathSanitizeReport` summarises how many path-shaped fields the importer
 * rewrote on the way in: `related_files[]` entries plus a single boolean
 * for `working_directory`. The CLI wrapper surfaces this as a one-line
 * stderr warning when the total is non-zero so the operator sees that
 * machine-private prefixes were stripped.
 */
export type ImportSessionResult = {
  sessionId: PrefixedId<"ses">;
  eventCount: number;
  finalStatus: SessionStatus;
  finalSourceKind: SessionSourceKind;
  pathSanitizeReport: {
    relatedFiles: number;
    workingDirectoryRewritten: boolean;
  };
};

/**
 * Import a round-trip JSON payload into `.basou/sessions/<new>/`. The caller
 * MUST validate the payload against {@link SessionImportPayloadSchema} first
 * and gate the `schema_version === "0.1.0"` literal check externally; this
 * function trusts both invariants.
 *
 * On success a fresh session ID is minted and a complete
 * `session.yaml` + `events.jsonl` pair is written atomically. On any post-
 * mkdir failure the session directory is removed best-effort so partial
 * imports do not leave `session_yaml_missing` half-states behind.
 *
 * Throws `Error` with one of the fixed messages enumerated by the import contract
 * §"Error messages" table; the original native error is attached as `cause`
 * for `--verbose` rendering.
 */
export async function importSessionFromJson(
  paths: BasouPaths,
  manifest: Manifest,
  payload: SessionImportPayload,
  options: ImportSessionOptions,
): Promise<ImportSessionResult> {
  // Defense in depth: the CLI converter (parseTaskIdOverride) already gates
  // this, but a direct core API caller could still pass an arbitrary string.
  if (
    options.taskIdOverride !== undefined &&
    !TaskIdSchema.safeParse(options.taskIdOverride).success
  ) {
    throw new Error(`Invalid task_id: ${options.taskIdOverride}`);
  }

  // Reachability guard: rewriteEvents
  // preserves variant-specific task_id fields, so importing a session that
  // references a task absent from the local workspace would silently
  // install a dangling reference. Validate every task_id carrier:
  // task_created / task_status_changed / task_reconciled events plus the
  // effective session task_id (override-wins, matches buildSessionRecord
  // below).
  const effectiveSessionTaskId = options.taskIdOverride ?? payload.session.task_id ?? null;
  await assertImportedTaskReferencesAreReachable(paths, payload.events, effectiveSessionTaskId);

  const newSessionId = prefixedUlid("ses");

  const rewrittenEvents = rewriteEvents(payload.events, newSessionId);
  assertChronologicalOrder(rewrittenEvents);

  const { record: sessionRecord, pathSanitizeReport } = buildSessionRecord(
    payload.session,
    manifest,
    newSessionId,
    options,
  );

  if (options.dryRun === true) {
    return {
      sessionId: newSessionId,
      eventCount: rewrittenEvents.length,
      finalStatus: "imported",
      finalSourceKind: sessionRecord.session.source.kind,
      pathSanitizeReport,
    };
  }

  // recursive: true lets a stripped-down workspace (manifest present but
  // `.basou/sessions` missing) recover instead of failing with ENOENT; ULID
  // collision on the new session dir itself is statistically impossible, so
  // the silent EEXIST on an existing directory is acceptable here. Concurrent
  // attempts to write the same session.yaml are caught by linkYamlFile below.
  const sessionDir = join(paths.sessions, newSessionId);
  try {
    await mkdir(sessionDir, { recursive: true });
  } catch (error: unknown) {
    throw new Error("Failed to create session directory", { cause: error });
  }

  try {
    await writeEventsBulk(sessionDir, rewrittenEvents);
  } catch (error: unknown) {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  try {
    const sessionYamlPath = join(sessionDir, "session.yaml");
    await linkYamlFile(sessionYamlPath, sessionRecord);
  } catch (error: unknown) {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    if (findErrorCode(error, "EEXIST")) {
      throw new Error("Session directory collision (retry the command)", {
        cause: error,
      });
    }
    throw error;
  }

  return {
    sessionId: newSessionId,
    eventCount: rewrittenEvents.length,
    finalStatus: "imported",
    finalSourceKind: sessionRecord.session.source.kind,
    pathSanitizeReport,
  };
}

// Reachability guard: refuse any payload that
// references task ids absent from the local workspace, across every carrier:
// task_created / task_status_changed / task_reconciled events plus the
// effective session task_id (= the override if supplied, otherwise the
// imported session.yaml.task_id; matches buildSessionRecord's override-wins
// semantics so we never reject on an id the final record will discard). The
// fixed message is pathless-contract compliant; broken ids are not echoed
// back so an adversarial payload cannot probe the local task namespace.
async function assertImportedTaskReferencesAreReachable(
  paths: BasouPaths,
  events: ReadonlyArray<Event>,
  effectiveSessionTaskId: string | null,
): Promise<void> {
  const taskIdsToCheck = new Set<string>();
  for (const ev of events) {
    if (
      ev.type === "task_created" ||
      ev.type === "task_status_changed" ||
      ev.type === "task_reconciled" ||
      ev.type === "task_linkage_refreshed" ||
      ev.type === "task_deleted" ||
      ev.type === "task_archived"
    ) {
      taskIdsToCheck.add(ev.task_id);
    }
  }
  if (effectiveSessionTaskId !== null) {
    taskIdsToCheck.add(effectiveSessionTaskId);
  }
  if (taskIdsToCheck.size === 0) {
    // skip the tasks-dir scan when nothing references a task,
    // so imports that carry no task_id at all keep the original perf.
    return;
  }
  const knownTaskIds = new Set(await enumerateTaskIds(paths));
  for (const id of taskIdsToCheck) {
    if (!knownTaskIds.has(id)) {
      throw new Error("Imported session references unknown task_id");
    }
  }
}

// Rewrite each event's `id` and `session_id` to brand-new values while
// retaining every other field — including variant-specific cross-reference
// IDs (approval_id, decision_id, task_id, file paths, raw_ref) — so that
// chains like `approval_requested` -> `approval_approved` remain joinable on
// the imported side. The events were already validated against EventSchema,
// and prefixedUlid output satisfies EventIdSchema by construction, so the
// rewritten events do not need to be re-parsed.
function rewriteEvents(events: Event[], newSessionId: PrefixedId<"ses">): Event[] {
  return events.map((event) => ({
    ...event,
    id: prefixedUlid("evt"),
    session_id: newSessionId,
  }));
}

// Enforce strict chronological order with same-ms duplicates allowed (`>=`).
// Out-of-order events indicate an exporter bug or
// hand-edited payload — refuse to silently sort.
function assertChronologicalOrder(events: Event[]): void {
  for (let i = 1; i < events.length; i++) {
    const prevEvent = events[i - 1];
    const currEvent = events[i];
    if (prevEvent === undefined || currEvent === undefined) continue;
    const prev = Date.parse(prevEvent.occurred_at);
    const curr = Date.parse(currEvent.occurred_at);
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || curr < prev) {
      throw new Error("Events are not in chronological order");
    }
  }
}

function buildSessionRecord(
  input: SessionInnerImportInput,
  manifest: Manifest,
  newSessionId: PrefixedId<"ses">,
  options: ImportSessionOptions,
): {
  record: Session;
  pathSanitizeReport: ImportSessionResult["pathSanitizeReport"];
} {
  // Sanitize before constructing the record so the operator-private
  // absolute prefix never reaches disk (= same write-time policy as
  // run.ts / exec.ts / ad-hoc-session.ts). We use the imported
  // working_directory itself as the base for related_files so paths
  // recorded relative to the original repo continue to read as
  // repo-internal; the working_directory field itself is sanitized via
  // the sentinel-based helper so the same value yields "~/projects/foo"
  // instead of collapsing to ".".
  const home = homedir();
  const workingDirectoryRaw = input.working_directory;
  const workingDirectorySanitized = sanitizeWorkingDirectory(workingDirectoryRaw, {
    homedir: home,
  });
  const relatedSanitized = sanitizeRelatedFiles(input.related_files, {
    workingDirectory: workingDirectoryRaw,
    homedir: home,
  });

  const inner: Session["session"] = {
    id: newSessionId,
    ...(options.labelOverride !== undefined || input.label !== undefined
      ? { label: options.labelOverride ?? input.label }
      : {}),
    task_id:
      options.taskIdOverride !== undefined
        ? (options.taskIdOverride as Session["session"]["task_id"])
        : (input.task_id ?? null),
    workspace_id: manifest.workspace.id,
    source: input.source,
    started_at: input.started_at,
    ...(input.ended_at !== undefined ? { ended_at: input.ended_at } : {}),
    status: "imported",
    working_directory: workingDirectorySanitized,
    invocation: input.invocation,
    related_files: relatedSanitized.sanitized,
    events_log: "events.jsonl",
    summary: input.summary ?? null,
  };
  return {
    record: { schema_version: "0.1.0", session: inner },
    pathSanitizeReport: {
      relatedFiles: relatedSanitized.mutationCount,
      workingDirectoryRewritten: workingDirectorySanitized !== workingDirectoryRaw,
    },
  };
}
