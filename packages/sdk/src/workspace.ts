import { join, resolve } from "node:path";
import {
  ApprovalIdSchema,
  assertBasouRootSafe,
  basouPaths,
  buildStatusSnapshot,
  computeWorkStats,
  type Event,
  enumerateApprovals,
  type LoadedApproval,
  loadApproval,
  loadSessionEntries,
  loadTaskEntries,
  type Manifest,
  readAllEvents,
  readManifest,
  readTaskFileWithArchiveFallback,
  renderDecisions,
  renderHandoff,
  renderReport,
  replayEvents,
  resolveRepositoryRoot,
  resolveSessionId,
  resolveTaskId,
  type SessionEntry,
  type StatusSnapshot,
  type TaskDocument,
  type WorkStatsResult,
} from "@basou/core";
import {
  AmbiguousIdError,
  ApprovalStoreUnsafeError,
  SessionStoreUnsafeError,
  type StoreUnsafeError,
  TaskStoreUnsafeError,
  WorkspaceNotFoundError,
} from "./errors.js";

/**
 * A degradation the SDK noticed while reading provenance: a malformed event
 * line, or a session / task that could not be loaded. Best-effort reads skip
 * these and keep going; pass `onDiagnostic` to {@link openWorkspace} to observe
 * them. `message` is a human-readable summary (it folds in the core
 * `ReplayWarning.kind` or skip-reason); structured fields are intentionally not
 * part of this stable shape.
 */
export type WorkspaceDiagnostic = {
  /** Human-readable summary of the malformed line / skipped record. */
  message: string;
  /** Session or task id the diagnostic relates to, when known. */
  id?: string;
};

/** Options for {@link openWorkspace}; all optional. */
export type WorkspaceOptions = {
  /**
   * Clock used for time-sensitive reads (session "suspect" classification,
   * stats span-to-now, status / approval expiry). Injectable for deterministic
   * callers and tests. Defaults to `() => new Date()`, evaluated per call.
   */
  now?: () => Date;
  /**
   * Observe a malformed event line or a skipped session / task instead of it
   * being silently dropped. Reads are still best-effort: a diagnostic does not
   * fail the call.
   */
  onDiagnostic?: (diagnostic: WorkspaceDiagnostic) => void;
};

/** Options for {@link Workspace.stats}. */
export type StatsOptions = {
  /**
   * IANA timezone used to bucket the per-day breakdown (native logs are UTC).
   * Defaults to the host's local zone.
   */
  timeZone?: string;
};

/**
 * A read-only handle on one Basou workspace (`<root>/.basou/`). Every method
 * reads provenance from disk; the SDK exposes no writers. Obtain one with
 * {@link openWorkspace}.
 *
 * Session / task lookups (`getSession`, `getTask`, `readEvents`,
 * `streamEvents`) accept a full id or a unique prefix: a prefix matching
 * nothing yields `null` (or an empty stream), a prefix matching more than one
 * record throws {@link AmbiguousIdError}. `getApproval` takes an exact id only.
 *
 * A read throws a {@link StoreUnsafeError} when a directory of the store it
 * needs is a symlink or not a directory, and the subclass names the store:
 *
 * - {@link SessionStoreUnsafeError} for `.basou/sessions`, from
 *   `listSessions`, `getSession`, `readEvents`, `streamEvents`, `stats`,
 *   `renderHandoff`, `renderDecisions` and `renderReport`;
 * - {@link TaskStoreUnsafeError} for `.basou/tasks` or `.basou/tasks/archive`,
 *   from `listTasks`, `getTask`, `renderHandoff` and `renderReport`;
 * - {@link ApprovalStoreUnsafeError} for `.basou/approvals`,
 *   `.basou/approvals/pending` or `.basou/approvals/resolved`, from
 *   `listApprovals`, `getApproval`, `renderHandoff` and `renderReport`.
 *
 * These are the stores each read needs today; a read that comes to need
 * another store throws for it too, so catch {@link StoreUnsafeError} rather
 * than the subclass a read throws today. A read that needs more than one
 * store throws for the first refused directory it reaches. `streamEvents`
 * throws from the stream, when it is
 * read. The exception is a lookup given an id that cannot name a record: a
 * session or task lookup (`getSession`, `readEvents`, `streamEvents`,
 * `getTask`) given an id that is empty once trimmed, or the prefix (`ses_`,
 * `task_`) alone, and `getApproval` given a string that is not an approval id
 * (`appr_` and a ULID). It yields `null` (or nothing) before anything is read,
 * as it does for any workspace. `manifest` reads none of these stores and
 * works as usual. `status` does not throw either: it reports `sessions`,
 * `tasks`, `approvals_pending` and `approvals_resolved` that are themselves a
 * symlink or a file as missing (`false` in `directories_present`). It does not
 * yet look at `.basou/approvals` itself, so today a symlink there leaves the
 * two approval keys `true`; that is a known limitation, not a promise.
 */
export interface Workspace {
  /** Absolute repository root this workspace was opened at. */
  readonly root: string;

  /** Parsed `manifest.yaml`. */
  manifest(): Promise<Manifest>;
  /** A freshly computed workspace status snapshot (directory presence + manifest). */
  status(): Promise<StatusSnapshot>;

  /** Every session, ULID-ascending, each with its `suspect` classification. */
  listSessions(): Promise<SessionEntry[]>;
  /** One session by id / unique prefix, or `null` if no session matches. */
  getSession(idOrPrefix: string): Promise<SessionEntry | null>;
  /** All events of a session, eagerly, ordered as written. Empty if no match. */
  readEvents(idOrPrefix: string): Promise<Event[]>;
  /** All events of a session as a lazy stream (for large logs). */
  streamEvents(idOrPrefix: string): AsyncIterable<Event>;

  /** Every task (active + lazily-indexed), created-at ascending. */
  listTasks(): Promise<TaskDocument[]>;
  /** One task by id / unique prefix (archived included), or `null`. */
  getTask(idOrPrefix: string): Promise<TaskDocument | null>;

  /** Pending + resolved approvals, fully loaded. */
  listApprovals(): Promise<{ pending: LoadedApproval[]; resolved: LoadedApproval[] }>;
  /**
   * One approval by exact id (resolved checked first), or `null` — also for a
   * string that is not an approval id, which is not looked up.
   */
  getApproval(id: string): Promise<LoadedApproval | null>;

  /** Aggregated work / time / token stats across the workspace's sessions. */
  stats(options?: StatsOptions): Promise<WorkStatsResult>;

  /** The rendered `handoff.md` body (recomputed, without generated markers). */
  renderHandoff(): Promise<string>;
  /** The rendered `decisions.md` body (recomputed, without generated markers). */
  renderDecisions(): Promise<string>;
  /**
   * A rendered work report — a point-in-time markdown export explaining the
   * work captured in this workspace (volume, decisions, approvals, tasks,
   * changed files, and the local provenance integrity verdicts). Read-only,
   * markerless. The CLI's `--json` structured shape is a CLI concern; the SDK
   * facade returns the markdown body, mirroring `renderHandoff` / `renderDecisions`.
   */
  renderReport(options?: ReportOptions): Promise<string>;
}

/** Options for {@link Workspace.renderReport}. */
export type ReportOptions = {
  /** Subject line shown in the report header. */
  title?: string;
  /**
   * IANA timezone used to label the report's time figures. Defaults to the
   * host's local zone (matching {@link StatsOptions.timeZone}).
   */
  timeZone?: string;
};

/**
 * Resolve the Basou workspace root for a working directory by finding the
 * enclosing git repository root (`.basou/` lives at the repo root). A
 * convenience for the common "I'm somewhere in the repo" case; requires git
 * and a repository. Pass the returned path to {@link openWorkspace}. When you
 * already know the root (CI checkout, a copied `.basou/`), skip this and call
 * {@link openWorkspace} directly — it needs no git.
 */
export function resolveWorkspaceRoot(cwd: string): Promise<string> {
  return resolveRepositoryRoot(cwd);
}

/**
 * Open a read-only handle on the Basou workspace rooted at `repoRoot` (the
 * directory that contains `.basou/`). Validates that `.basou/` exists and is a
 * real directory; throws {@link WorkspaceNotFoundError} otherwise. It does not
 * check the directories inside it: the reads that need one check it each time
 * they are called (see {@link Workspace}). No git is required — point it at
 * any directory holding a `.basou/`.
 */
export async function openWorkspace(
  repoRoot: string,
  options: WorkspaceOptions = {},
): Promise<Workspace> {
  // Normalize to an absolute path up front so `root` honors its documented
  // absolute-path contract even when the caller passes a relative directory.
  const root = resolve(repoRoot);
  const paths = basouPaths(root);
  try {
    await assertBasouRootSafe(paths.root);
  } catch (cause) {
    throw new WorkspaceNotFoundError(root, { cause });
  }
  const now = options.now ?? (() => new Date());
  const emit = options.onDiagnostic;
  const onWarning = (warning: { kind: string; line?: number }, id?: string): void =>
    emit?.({
      message: `event ${warning.kind}${warning.line ? ` (line ${warning.line})` : ""}`,
      ...(id !== undefined ? { id } : {}),
    });
  const onSkip = (id: string, reason: string): void =>
    emit?.({ message: `skipped: ${reason}`, id });

  /** Resolve a session prefix to a full id, or null when nothing matches. */
  const resolveSession = (input: string): Promise<string | null> =>
    resolveOrNull(() => resolveSessionId(paths, input), input);
  const resolveTask = (input: string): Promise<string | null> =>
    resolveOrNull(() => resolveTaskId(paths, input, { includeArchived: true }), input);

  return {
    root,

    manifest: () => readManifest(paths),

    status: async () =>
      buildStatusSnapshot({ manifest: await readManifest(paths), paths, now: now() }),

    listSessions: () =>
      guardStore(root, () =>
        loadSessionEntries(paths, {
          now: now(),
          onWarning: (w, sid) => onWarning(w, sid),
          onSkip,
        }),
      ),

    getSession: (idOrPrefix) =>
      guardStore(root, async () => {
        const id = await resolveSession(idOrPrefix);
        if (id === null) return null;
        const entries = await loadSessionEntries(paths, {
          now: now(),
          onWarning: (w, sid) => onWarning(w, sid),
          onSkip,
        });
        return entries.find((e) => e.sessionId === id) ?? null;
      }),

    readEvents: (idOrPrefix) =>
      guardStore(root, async () => {
        const id = await resolveSession(idOrPrefix);
        if (id === null) return [];
        return readAllEvents(join(paths.sessions, id), { onWarning: (w) => onWarning(w, id) });
      }),

    streamEvents: (idOrPrefix): AsyncIterable<Event> => {
      async function* iterate(): AsyncGenerator<Event> {
        try {
          const id = await resolveSession(idOrPrefix);
          if (id === null) return;
          yield* replayEvents(join(paths.sessions, id), { onWarning: (w) => onWarning(w, id) });
        } catch (error) {
          throw toStoreError(root, error);
        }
      }
      return iterate();
    },

    listTasks: () => guardStore(root, () => loadTaskEntries(paths, { onSkip })),

    getTask: (idOrPrefix) =>
      guardStore(root, async () => {
        const id = await resolveTask(idOrPrefix);
        if (id === null) return null;
        const { doc } = await readTaskFileWithArchiveFallback(paths, id);
        return doc;
      }),

    listApprovals: () =>
      guardStore(root, async () => {
        const ids = await enumerateApprovals(paths);
        // `loadApproval` searches resolved/ before pending/, so an id present in
        // BOTH (a stale pending file left after resolution) would otherwise load
        // the resolved record into the pending list too. Drop those from pending
        // so a resolved approval is reported once, under `resolved`.
        const resolvedSet = new Set(ids.resolved);
        const pendingIds = ids.pending.filter((id) => !resolvedSet.has(id));
        const load = async (id: string): Promise<LoadedApproval | null> => loadApproval(paths, id);
        const [pending, resolved] = await Promise.all([
          Promise.all(pendingIds.map(load)),
          Promise.all(ids.resolved.map(load)),
        ]);
        return {
          pending: pending.filter((a): a is LoadedApproval => a !== null),
          resolved: resolved.filter((a): a is LoadedApproval => a !== null),
        };
      }),

    // The id becomes a file name, so one that is not an approval id (`../x`)
    // is answered here, without looking at the store or anything outside it.
    getApproval: async (id) =>
      ApprovalIdSchema.safeParse(id).success
        ? guardStore(root, () => loadApproval(paths, id))
        : null,

    stats: (statsOptions) =>
      guardStore(root, () =>
        computeWorkStats({
          paths,
          now: now(),
          ...(statsOptions?.timeZone !== undefined ? { timeZone: statsOptions.timeZone } : {}),
          onWarning: (w, sid) => onWarning(w, sid),
          onSessionSkip: onSkip,
        }),
      ),

    renderHandoff: () =>
      guardStore(root, async () => {
        const result = await renderHandoff({
          paths,
          nowIso: now().toISOString(),
          onWarning: (w, sid) => onWarning(w, sid),
          onSessionSkip: onSkip,
          onTaskSkip: onSkip,
        });
        return result.body;
      }),

    renderDecisions: () =>
      guardStore(root, async () => {
        const result = await renderDecisions({
          paths,
          nowIso: now().toISOString(),
          onWarning: (w, sid) => onWarning(w, sid),
          onSessionSkip: onSkip,
        });
        return result.body;
      }),

    renderReport: (reportOptions) =>
      guardStore(root, async () => {
        const result = await renderReport({
          paths,
          nowIso: now().toISOString(),
          ...(reportOptions?.title !== undefined ? { title: reportOptions.title } : {}),
          ...(reportOptions?.timeZone !== undefined ? { timeZone: reportOptions.timeZone } : {}),
          onWarning: (w, sid) => onWarning(w, sid),
          onSessionSkip: onSkip,
          onTaskSkip: onSkip,
        });
        return result.body;
      }),
  };
}

/**
 * The directories of the store that `@basou/core` refuses when they are a
 * symlink or not a directory, each with the SDK error that names its store.
 */
type StoreErrorClass = new (
  root: string,
  message: string,
  options?: { cause?: unknown },
) => StoreUnsafeError;

const STORE_DIRECTORIES: ReadonlyArray<readonly [label: string, error: StoreErrorClass]> = [
  [".basou/sessions", SessionStoreUnsafeError],
  [".basou/tasks", TaskStoreUnsafeError],
  [".basou/tasks/archive", TaskStoreUnsafeError],
  [".basou/approvals", ApprovalStoreUnsafeError],
  [".basou/approvals/pending", ApprovalStoreUnsafeError],
  [".basou/approvals/resolved", ApprovalStoreUnsafeError],
];

/**
 * The messages core's store checks give for those directories, each mapped to
 * its SDK error. Matched exactly, as {@link resolveOrNull} matches the
 * resolver's contract strings, so no other error is retyped.
 */
const STORE_REFUSALS: ReadonlyMap<string, StoreErrorClass> = new Map(
  STORE_DIRECTORIES.flatMap(([label, error]) => [
    [`${label} is a symlink; refusing to operate`, error] as const,
    [`${label} exists but is not a directory`, error] as const,
  ]),
);

/**
 * Return core's refusal of a directory of the store as the
 * {@link StoreUnsafeError} subclass for that store, for the workspace at
 * `root`, keeping its message and attaching it as the cause. Any other error
 * is returned unchanged.
 */
function toStoreError(root: string, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const StoreError = STORE_REFUSALS.get(error.message);
  return StoreError === undefined ? error : new StoreError(root, error.message, { cause: error });
}

/** Run a read of the store, retyping a store refusal it throws. */
async function guardStore<T>(root: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw toStoreError(root, error);
  }
}

/**
 * Run a core id-resolver and normalize its outcome: a successful resolution
 * returns the id; the "not found" / "empty input" contract errors map to
 * `null` (no such record); the "ambiguous" contract error maps to
 * {@link AmbiguousIdError}. Any other error propagates unchanged.
 */
async function resolveOrNull(
  resolver: () => Promise<string>,
  input: string,
): Promise<string | null> {
  try {
    return await resolver();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Match the core resolver's exact contract strings (id-resolver.ts), not a
    // loose substring, so an unrelated error that merely contains "not found"
    // is never silently swallowed to null.
    if (/^Ambiguous (session|task) id /.test(message)) {
      throw new AmbiguousIdError(input, { cause: error });
    }
    // An entry named as the session that is not a directory (a symlink, a
    // file) is not followed, so there is no session to return, as before.
    if (
      /^(Session|Task) not found: /.test(message) ||
      /^(Session|Task) id is empty$/.test(message) ||
      /^(Session|Task) \S+ is not a directory; a symlink or a file there is not followed$/.test(
        message,
      )
    ) {
      return null;
    }
    throw error;
  }
}
