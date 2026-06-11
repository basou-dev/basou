import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chainRawJsonLines } from "../events/chain.js";
import { readAllEvents } from "../events/event-replay.js";
import { type BulkChainResult, writeEventsBulk } from "../events/event-writer.js";
import { verifyEventsChain } from "../events/verify.js";
import { type PrefixedId, prefixedUlid } from "../ids/ulid.js";
import { findErrorCode } from "../lib/error-codes.js";
import { sanitizeRelatedFiles, sanitizeWorkingDirectory } from "../lib/path-sanitizer.js";
import { type Event, EventSchema } from "../schemas/event.schema.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import type { Session, SessionSourceKind, SessionStatus } from "../schemas/session.schema.js";
import type {
  SessionImportPayload,
  SessionInnerImportInput,
} from "../schemas/session-import.schema.js";
import { TaskIdSchema } from "../schemas/shared.schema.js";
import { atomicReplace } from "./atomic.js";
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

  // Chained write: imported sessions are the tamper-evident corpus, so the
  // bulk write threads the per-line hash chain and returns the head anchor.
  let chainResult: BulkChainResult | null;
  try {
    chainResult = await writeEventsBulk(sessionDir, rewrittenEvents, { chain: true });
  } catch (error: unknown) {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  try {
    const sessionYamlPath = join(sessionDir, "session.yaml");
    await linkYamlFile(sessionYamlPath, withIntegrity(sessionRecord, chainResult));
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

// Attach the head anchor returned by a chained writeEventsBulk to a session
// record about to be persisted. A null chain result (empty event batch) leaves
// the record anchor-less, matching the zero-byte events.jsonl on disk.
function withIntegrity(record: Session, chainResult: BulkChainResult | null): Session {
  if (chainResult === null) return record;
  return {
    ...record,
    session: {
      ...record.session,
      integrity: { head_hash: chainResult.headHash, event_count: chainResult.count },
    },
  };
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
      // `prior_chain_broken`: the prior events.jsonl failed hash-chain
      //   verification (tampered). Aborted so a re-import cannot launder a
      //   broken chain into a freshly-valid one; the operator inspects with
      //   `basou verify` and decides (`--force` rebuilds from scratch).
      reason: "prior_events_unreadable" | "prior_derived_dropped" | "prior_chain_broken";
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
    // Pre-verify the prior chain BEFORE deriving anything from it: a re-import
    // that reuses event ids out of a hash-broken log would launder the break
    // into a freshly-valid chain. An `unchained` prior (imported before
    // chaining existed) passes — there is no chain to break, and the rewrite
    // below chains it. `incomplete` (yaml lost) also passes: the events are
    // internally consistent and the rewrite repairs the missing anchor.
    const priorVerdict = await verifyEventsChain(paths, priorSessionId);
    if (priorVerdict.status === "tampered") {
      return { status: "skipped", reason: "prior_chain_broken" };
    }

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
      // Defensive: keep any task_id already present on the prior yaml so a
      // re-derive never drops a link, whatever wrote it.
      task_id: prior.session.task_id ?? null,
      // Re-derivation always yields a null summary; keep a prior non-null one.
      summary: prior.session.summary ?? record.session.summary ?? null,
    };
    const updatedRecord: Session = { schema_version: "0.1.0", session: preservedInner };

    if (options.dryRun !== true) {
      // Capture the prior events.jsonl RAW BYTES before the rewrite so a
      // session.yaml failure can restore them VERBATIM. Re-serializing
      // `priorEvents` here instead would write an UNCHAINED file (the parsed
      // events lost their byte-exact form), contradicting the prior anchor.
      const eventsPath = join(sessionDir, "events.jsonl");
      let priorEventsRaw: Buffer | null = null;
      try {
        priorEventsRaw = await readFile(eventsPath);
      } catch (error: unknown) {
        if (!findErrorCode(error, "ENOENT")) {
          throw new Error("Failed to read events.jsonl", { cause: error });
        }
      }

      const chainResult = await writeEventsBulk(sessionDir, mergedEvents, { chain: true });
      try {
        await overwriteYamlFile(
          join(sessionDir, "session.yaml"),
          withIntegrity(updatedRecord, chainResult),
        );
      } catch (error: unknown) {
        // events.jsonl and session.yaml are two separate atomic writes. If the
        // yaml write fails after the events were rewritten, restore the prior
        // events bytes so the session is never left with fresh events paired
        // with stale metadata (size / label / metrics / integrity anchor). The
        // yaml itself needs no restore: an atomic replace that threw never
        // renamed over the prior file.
        if (priorEventsRaw !== null) {
          await atomicReplace(eventsPath, priorEventsRaw).catch(() => undefined);
        } else {
          await rm(eventsPath, { force: true }).catch(() => undefined);
        }
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

/** Options for {@link rechainSessionInPlace}. */
export type RechainOptions = {
  /**
   * Compute the outcome and write nothing. The session lock is STILL taken:
   * an unlocked read could observe a concurrent in-place re-import's
   * two-file write window (events rewritten, yaml not yet) and report a
   * state a locked run would never see.
   */
  dryRun?: boolean;
};

/** Result of {@link rechainSessionInPlace}. */
export type RechainResult =
  | { status: "rechained"; eventCount: number }
  | {
      status: "skipped";
      // `already_chained`: the session is `verified` — idempotent no-op.
      // `empty`: zero events; nothing to chain and no anchor is written
      //   (same rule as the import writers).
      // `not_imported`: only the closed imported corpus may be chained — a
      //   live/ad-hoc session would be appended to afterwards and turn
      //   `tampered`.
      // `tampered`: the log already fails verification; rechaining it would
      //   launder the break into a fresh valid chain. Inspect with
      //   `basou verify`; `--force` re-import is the explicit override.
      // `events_unreadable`: a line cannot be preserved EXACTLY (blank or
      //   whitespace-only line, invalid UTF-8, JSON parse failure, schema
      //   gate failure, or a non-byte-identical JSON round-trip) — rechain
      //   never normalizes or drops content.
      // `session_id_mismatch`: a line's session_id is not this session's id;
      //   chaining it would manufacture an instantly-tampered session.
      // `yaml_missing` / `yaml_unreadable`: session.yaml absent / unparseable.
      reason:
        | "already_chained"
        | "empty"
        | "not_imported"
        | "tampered"
        | "events_unreadable"
        | "session_id_mismatch"
        | "yaml_missing"
        | "yaml_unreadable";
    };

/**
 * Add the tamper-evidence hash chain, IN PLACE, to an imported session that
 * was written before chaining existed (or whose chain was legitimately never
 * computed). Event ids, order, field sets, values and key order are all
 * preserved exactly — each original line is re-emitted with only `prev_hash`
 * appended (see {@link chainRawJsonLines}); `session.yaml` is rewritten as
 * read with only `integrity` added. Nothing else changes, so cross-session
 * references (`linked_events`) survive, unlike a `--force` re-import.
 *
 * Rechaining asserts tamper-evidence FROM NOW ON; it does not retroactively
 * prove the pre-existing content was never modified before the migration.
 *
 * Refuses anything it cannot preserve exactly or that is not the closed
 * imported corpus — see {@link RechainResult} reasons. Throws (rather than
 * returning a skip) on environment-level I/O failures, mirroring
 * `verifyEventsChain`.
 */
export async function rechainSessionInPlace(
  paths: BasouPaths,
  sessionId: string,
  options: RechainOptions = {},
): Promise<RechainResult> {
  const sessionDir = join(paths.sessions, sessionId);
  // Wrap lock-acquisition failures in the fixed pathless vocabulary: the CLI
  // surfaces per-session error messages verbatim, so a raw fs error here
  // would leak an absolute lockfile path.
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(paths, "session", sessionId);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Lock is held by another process") {
      throw error;
    }
    throw new Error("Failed to acquire lock", { cause: error });
  }
  try {
    // 1. Status gate: only the imported corpus is closed against appends.
    let record: Session;
    try {
      record = await readSessionYaml(paths, sessionId);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "YAML file not found") {
        return { status: "skipped", reason: "yaml_missing" };
      }
      return { status: "skipped", reason: "yaml_unreadable" };
    }
    if (record.session.status !== "imported") {
      return { status: "skipped", reason: "not_imported" };
    }

    // 2. Verdict gate. Only a clean `unchained` log proceeds; `incomplete`
    // is unreachable here because the yaml-missing case returned above.
    const verdict = await verifyEventsChain(paths, sessionId);
    if (verdict.status === "verified") {
      return { status: "skipped", reason: "already_chained" };
    }
    if (verdict.status === "empty") {
      return { status: "skipped", reason: "empty" };
    }
    if (verdict.status !== "unchained") {
      return { status: "skipped", reason: "tampered" };
    }

    // 3. Raw-line gate: every line must be preservable EXACTLY. The decoded
    // text must re-encode to the same bytes (invalid UTF-8 would silently
    // normalize to U+FFFD), and every line must be byte-identical to its own
    // JSON round-trip (whitespace padding, duplicate keys or non-canonical
    // escapes would otherwise be silently rewritten). Every line a basou
    // writer produced satisfies both.
    const eventsPath = join(sessionDir, "events.jsonl");
    let priorRaw: Buffer;
    try {
      priorRaw = await readFile(eventsPath);
    } catch (error: unknown) {
      throw new Error("Failed to read events.jsonl", { cause: error });
    }
    if (priorRaw.length === 0 || priorRaw[priorRaw.length - 1] !== 0x0a) {
      return { status: "skipped", reason: "events_unreadable" };
    }
    const text = priorRaw.toString("utf8");
    if (!priorRaw.equals(Buffer.from(text, "utf8"))) {
      return { status: "skipped", reason: "events_unreadable" };
    }
    const rawLines = text.slice(0, -1).split("\n");
    for (const line of rawLines) {
      if (line.trim().length === 0) {
        return { status: "skipped", reason: "events_unreadable" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { status: "skipped", reason: "events_unreadable" };
      }
      if (JSON.stringify(parsed) !== line) {
        return { status: "skipped", reason: "events_unreadable" };
      }
      // Gate ONLY: the parsed/validated output is never written.
      if (!EventSchema.safeParse(parsed).success) {
        return { status: "skipped", reason: "events_unreadable" };
      }
      if ((parsed as Record<string, unknown>).session_id !== sessionId) {
        return { status: "skipped", reason: "session_id_mismatch" };
      }
    }

    if (options.dryRun === true) {
      return { status: "rechained", eventCount: rawLines.length };
    }

    // 4-6. Chain the ORIGINAL lines, write atomically, anchor the yaml read
    // in step 1 (all other fields preserved as-is). On a yaml failure,
    // restore the prior events bytes verbatim — same rollback as the
    // in-place re-import.
    const chainResult = chainRawJsonLines(rawLines, sessionId);
    const body = `${chainResult.lines.join("\n")}\n`;
    try {
      await atomicReplace(eventsPath, body);
    } catch (error: unknown) {
      throw new Error("Failed to write events.jsonl", { cause: error });
    }
    try {
      await overwriteYamlFile(
        join(sessionDir, "session.yaml"),
        withIntegrity(record, { headHash: chainResult.headHash, count: chainResult.count }),
      );
    } catch (error: unknown) {
      await atomicReplace(eventsPath, priorRaw).catch(() => undefined);
      throw error;
    }

    return { status: "rechained", eventCount: chainResult.count };
  } finally {
    await lock.release();
  }
}
