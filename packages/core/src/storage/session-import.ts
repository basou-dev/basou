import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAllEvents } from "../events/event-replay.js";
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
import { acquireLock } from "./lockfile.js";
import { readSessionYaml } from "./sessions.js";
import { enumerateTaskIds } from "./tasks.js";
import { linkYamlFile, overwriteYamlFile } from "./yaml-store.js";

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
    ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
  };
  return {
    record: { schema_version: "0.1.0", session: inner },
    pathSanitizeReport: {
      relatedFiles: relatedSanitized.mutationCount,
      workingDirectoryRewritten: workingDirectorySanitized !== workingDirectoryRaw,
    },
  };
}

/**
 * The closed allowlist of session source kinds that are import-DERIVED (an
 * adapter mechanically derived the events from a native log). Used to
 * discriminate the events a scoped re-import re-derives from the ones it
 * preserves. `EventSourceSchema` is open vocab, so this is a deliberate
 * allowlist: any source NOT in it is treated as non-derived and preserved.
 */
const IMPORT_DERIVED_SOURCES: ReadonlySet<string> = new Set<SessionSourceKind>([
  "claude-code-import",
  "codex-import",
]);

/** Whether `source` is one of the known import-derived event sources. */
export function isImportDerivedSource(source: string): boolean {
  return IMPORT_DERIVED_SOURCES.has(source);
}

/** Options for {@link reimportPreservingId}. */
export type ReimportOptions = {
  /** Compute the re-import and return its preview without writing to disk. */
  dryRun?: boolean;
};

/** Result of {@link reimportPreservingId}. */
export type ReimportResult =
  | {
      status: "reimported";
      sessionId: PrefixedId<"ses">;
      /** Total events written to the merged `events.jsonl`. */
      eventCount: number;
      /** Non-derived events (human / unknown source) carried over unchanged. */
      preservedCount: number;
      /** Derived events whose prior id (and decision_id) was reused. */
      reusedIdCount: number;
    }
  | {
      status: "skipped";
      // `prior_events_unreadable`: the prior events.jsonl had a line that could
      //   not be preserved, so the re-import was aborted to avoid dropping data
      //   on the atomic rewrite.
      // `prior_derived_dropped`: re-deriving the (grown) source would NOT
      //   reproduce some prior derived event, so its id would vanish — only
      //   possible on a non-append-only source change, which is out of scope.
      //   Aborted so an id a cross-session `linked_events` may reference is
      //   never silently dropped; `--force` rebuilds from scratch.
      reason: "prior_events_unreadable" | "prior_derived_dropped";
    };

/**
 * A stable content key for a DERIVED event, used to match a freshly-derived
 * event to its counterpart in the prior import so the prior event's id (and any
 * id-bearing field such as `decision_id`) can be reused — keeping cross-session
 * `decision_recorded.linked_events` references valid across a re-import. The key
 * is `type + occurred_at + the variant's salient derived fields` (the fields the
 * importers populate deterministically from the source records), so matching is
 * robust to record reordering between imports (a positional match is not).
 * `session_started` / `session_ended` are matched by role instead (a session has
 * exactly one of each, and `session_ended`'s occurred_at moves as the log grows).
 */
function derivedEventContentKey(event: Event): string {
  const base = `${event.type} ${event.occurred_at}`;
  switch (event.type) {
    case "command_executed":
      return `${base} ${event.command} ${event.args.join("")} ${event.cwd}`;
    case "file_changed":
      return `${base} ${event.path} ${event.change_type}`;
    case "decision_recorded":
      return `${base} ${event.title}`;
    default:
      return base;
  }
}

/**
 * Re-key the freshly-derived events (which carry placeholder ids) onto the
 * session being re-imported, reusing prior derived events' IDS wherever the
 * derivation is unchanged so their ids stay stable across the re-import:
 *
 * - `session_started` / `session_ended`: matched by role (a session has exactly
 *   one of each). The prior id is reused with the FRESH content, so
 *   `session_ended`'s occurred_at advances to the log's new end while the id is
 *   stable.
 * - every other derived event: matched to a prior derived event by content key
 *   (FIFO per key for same-key duplicates). A match reuses the prior `id` (and,
 *   for `decision_recorded`, the prior `decision_id`) but keeps the FRESH
 *   content, so a re-derived field that changed between imports (e.g. a Codex
 *   command's `exit_code` / `duration_ms` that filled in once it completed)
 *   updates; a miss is a genuinely new event and gets a fresh ULID.
 *
 * `droppedPriorDerived` is true when a prior derived event was NOT reproduced by
 * the fresh derivation — its id would be dropped. That cannot happen for an
 * append-only growth (the prior derivations all recur); it signals a non-append
 * source change, which the caller treats as out of scope and skips.
 */
function reuseDerivedIds(
  priorDerived: ReadonlyArray<Event>,
  freshDerived: ReadonlyArray<Event>,
  sessionId: PrefixedId<"ses">,
): { events: Event[]; reusedIdCount: number; droppedPriorDerived: boolean } {
  const priorStarted = priorDerived.find((e) => e.type === "session_started");
  const priorEnded = priorDerived.find((e) => e.type === "session_ended");
  let startedUsed = false;
  let endedUsed = false;
  // FIFO queue of prior MIDDLE events per content key.
  const middleByKey = new Map<string, Event[]>();
  for (const e of priorDerived) {
    if (e.type === "session_started" || e.type === "session_ended") continue;
    const key = derivedEventContentKey(e);
    const list = middleByKey.get(key);
    if (list === undefined) middleByKey.set(key, [e]);
    else list.push(e);
  }
  let reusedIdCount = 0;
  // Reuse the prior id (so a cross-session `linked_events` target survives) but
  // keep the FRESH content; carry the prior `decision_id` so a decision's
  // identity is stable too.
  const withReusedId = (fresh: Event, prior: Event): Event => {
    reusedIdCount++;
    if (fresh.type === "decision_recorded" && prior.type === "decision_recorded") {
      return { ...fresh, id: prior.id, session_id: sessionId, decision_id: prior.decision_id };
    }
    return { ...fresh, id: prior.id, session_id: sessionId };
  };
  const events = freshDerived.map((fresh): Event => {
    if (fresh.type === "session_started") {
      if (priorStarted !== undefined) {
        startedUsed = true;
        return withReusedId(fresh, priorStarted);
      }
      return { ...fresh, id: prefixedUlid("evt"), session_id: sessionId };
    }
    if (fresh.type === "session_ended") {
      if (priorEnded !== undefined) {
        endedUsed = true;
        return withReusedId(fresh, priorEnded);
      }
      return { ...fresh, id: prefixedUlid("evt"), session_id: sessionId };
    }
    const match = middleByKey.get(derivedEventContentKey(fresh))?.shift();
    if (match !== undefined) return withReusedId(fresh, match);
    return { ...fresh, id: prefixedUlid("evt"), session_id: sessionId };
  });
  // A prior derived event not consumed above would be DROPPED on the rewrite.
  const droppedPriorDerived =
    (priorStarted !== undefined && !startedUsed) ||
    (priorEnded !== undefined && !endedUsed) ||
    [...middleByKey.values()].some((q) => q.length > 0);
  return { events, reusedIdCount, droppedPriorDerived };
}

/**
 * Re-import a source whose native log GREW into the SAME Basou session,
 * preserving its id and any non-derived events, instead of skipping it (default
 * dedup) or deleting + recreating it (`--force`). The caller has already
 * validated `freshPayload` and confirmed (by source byte size) that the source
 * changed; this function re-derives the adapter's events, reuses prior derived
 * event ids for unchanged derivations (so `linked_events` references survive),
 * preserves human / unknown-source events, and rewrites `events.jsonl` +
 * `session.yaml` atomically under the session lock.
 *
 * The whole read-modify-write runs under {@link acquireLock} so a concurrent
 * writer cannot interleave; `dryRun` computes the result and writes nothing
 * (and takes no lock). If the prior `events.jsonl` has any line that cannot be
 * preserved (malformed / schema-invalid / half-written), the re-import is
 * ABORTED (`status: "skipped"`) rather than risk dropping data on the rewrite.
 */
export async function reimportPreservingId(
  paths: BasouPaths,
  manifest: Manifest,
  priorSessionId: string,
  freshPayload: SessionImportPayload,
  options: ReimportOptions = {},
): Promise<ReimportResult> {
  // The id originates from an on-disk session directory, so it is already a
  // valid `ses_<ULID>`; the cast threads it into the typed record builders.
  const sessionId = priorSessionId as PrefixedId<"ses">;
  const importSource = freshPayload.session.source.kind;
  const sessionDir = join(paths.sessions, priorSessionId);

  const lock = options.dryRun === true ? null : await acquireLock(paths, "session", priorSessionId);
  try {
    // Strict read of the prior events: abort on ANY unpreservable line so the
    // atomic rewrite below never silently drops a human / unknown-source event.
    let priorUnreadable = false;
    const priorEvents = await readAllEvents(sessionDir, {
      onWarning: () => {
        priorUnreadable = true;
      },
    });
    if (priorUnreadable) {
      return { status: "skipped", reason: "prior_events_unreadable" };
    }

    // Partition by event source: re-derive exactly the events THIS adapter
    // produced (source === importSource); preserve everything else (human
    // local-cli notes / decisions AND any unknown-source event, since
    // EventSourceSchema is open vocab).
    const priorDerived = priorEvents.filter((e) => e.source === importSource);
    const preserved = priorEvents.filter((e) => e.source !== importSource);

    const {
      events: rederived,
      reusedIdCount,
      droppedPriorDerived,
    } = reuseDerivedIds(priorDerived, freshPayload.events, sessionId);
    if (droppedPriorDerived) {
      // The grown source no longer reproduces some prior derived event, so its
      // id would vanish (only happens on a non-append-only change). Abort rather
      // than silently drop an id a cross-session linked_events may reference.
      return { status: "skipped", reason: "prior_derived_dropped" };
    }

    // Merge derived + preserved into one stream ordered by occurred_at (stable
    // sort => derived before preserved at an equal timestamp) and enforce the
    // same monotonic invariant a fresh import guarantees, so a re-imported
    // session is indistinguishable in shape from a freshly imported one.
    const mergedEvents = [...rederived, ...preserved].sort(
      (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
    );
    assertChronologicalOrder(mergedEvents);

    // Rebuild session.yaml from the fresh derivation (label, metrics, source +
    // size, related_files, timestamps, sanitized paths), preserving the id and
    // the human-owned fields a re-derivation must not clobber.
    const prior = await readSessionYaml(paths, priorSessionId);
    const { record } = buildSessionRecord(freshPayload.session, manifest, sessionId, {});
    const preservedInner: Session["session"] = {
      ...record.session,
      // A human may have linked this imported session to a task
      // (`basou task link` updates session.yaml.task_id even for imported
      // sessions); never drop that link on a re-derive.
      task_id: prior.session.task_id ?? null,
      // Re-derivation always yields a null summary; keep a prior non-null one.
      summary: prior.session.summary ?? record.session.summary ?? null,
    };
    const updatedRecord: Session = { schema_version: "0.1.0", session: preservedInner };

    if (options.dryRun !== true) {
      await writeEventsBulk(sessionDir, mergedEvents);
      try {
        await overwriteYamlFile(join(sessionDir, "session.yaml"), updatedRecord);
      } catch (error: unknown) {
        // events.jsonl and session.yaml are two separate atomic writes. If the
        // yaml write fails after the events were rewritten, roll the events back
        // to the prior set so the session is never left with fresh events paired
        // with stale metadata (size / label / metrics).
        await writeEventsBulk(sessionDir, priorEvents).catch(() => undefined);
        throw error;
      }
    }

    return {
      status: "reimported",
      sessionId,
      eventCount: mergedEvents.length,
      preservedCount: preserved.length,
      reusedIdCount,
    };
  } finally {
    await lock?.release();
  }
}
