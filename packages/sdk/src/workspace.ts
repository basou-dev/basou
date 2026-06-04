import { join, resolve } from "node:path";
import {
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
  replayEvents,
  resolveRepositoryRoot,
  resolveSessionId,
  resolveTaskId,
  type SessionEntry,
  type StatusSnapshot,
  type TaskDocument,
  type WorkStatsResult,
} from "@basou/core";
import { AmbiguousIdError, WorkspaceNotFoundError } from "./errors.js";

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
  /** One approval by exact id (resolved checked first), or `null`. */
  getApproval(id: string): Promise<LoadedApproval | null>;

  /** Aggregated work / time / token stats across the workspace's sessions. */
  stats(options?: StatsOptions): Promise<WorkStatsResult>;

  /** The rendered `handoff.md` body (recomputed, without generated markers). */
  renderHandoff(): Promise<string>;
  /** The rendered `decisions.md` body (recomputed, without generated markers). */
  renderDecisions(): Promise<string>;
}

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
 * real directory; throws {@link WorkspaceNotFoundError} otherwise. No git is
 * required — point it at any directory holding a `.basou/`.
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
      loadSessionEntries(paths, {
        now: now(),
        onWarning: (w, sid) => onWarning(w, sid),
        onSkip,
      }),

    getSession: async (idOrPrefix) => {
      const id = await resolveSession(idOrPrefix);
      if (id === null) return null;
      const entries = await loadSessionEntries(paths, {
        now: now(),
        onWarning: (w, sid) => onWarning(w, sid),
        onSkip,
      });
      return entries.find((e) => e.sessionId === id) ?? null;
    },

    readEvents: async (idOrPrefix) => {
      const id = await resolveSession(idOrPrefix);
      if (id === null) return [];
      return readAllEvents(join(paths.sessions, id), { onWarning: (w) => onWarning(w, id) });
    },

    streamEvents: (idOrPrefix): AsyncIterable<Event> => {
      async function* iterate(): AsyncGenerator<Event> {
        const id = await resolveSession(idOrPrefix);
        if (id === null) return;
        yield* replayEvents(join(paths.sessions, id), { onWarning: (w) => onWarning(w, id) });
      }
      return iterate();
    },

    listTasks: () => loadTaskEntries(paths, { onSkip }),

    getTask: async (idOrPrefix) => {
      const id = await resolveTask(idOrPrefix);
      if (id === null) return null;
      const { doc } = await readTaskFileWithArchiveFallback(paths, id);
      return doc;
    },

    listApprovals: async () => {
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
    },

    getApproval: (id) => loadApproval(paths, id),

    stats: (statsOptions) =>
      computeWorkStats({
        paths,
        now: now(),
        ...(statsOptions?.timeZone !== undefined ? { timeZone: statsOptions.timeZone } : {}),
        onWarning: (w, sid) => onWarning(w, sid),
        onSessionSkip: onSkip,
      }),

    renderHandoff: async () => {
      const result = await renderHandoff({
        paths,
        nowIso: now().toISOString(),
        onWarning: (w, sid) => onWarning(w, sid),
        onSessionSkip: onSkip,
        onTaskSkip: onSkip,
      });
      return result.body;
    },

    renderDecisions: async () => {
      const result = await renderDecisions({
        paths,
        nowIso: now().toISOString(),
        onWarning: (w, sid) => onWarning(w, sid),
        onSessionSkip: onSkip,
      });
      return result.body;
    },
  };
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
    if (
      /^(Session|Task) not found: /.test(message) ||
      /^(Session|Task) id is empty$/.test(message)
    ) {
      return null;
    }
    throw error;
  }
}
