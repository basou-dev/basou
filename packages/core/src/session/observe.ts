import { resolve } from "node:path";
import { getChangesSince } from "../git/diff.js";
import { getOwnCommitPaths } from "../git/own-commits.js";
import {
  getUntrackedFiles,
  getWorkingTreeChanges,
  readEmptyTreeSha,
  readHeadSha,
} from "../git/working-tree.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import {
  type ObservedFile,
  type ObservedRepo,
  observedFileFrom,
  readSessionObservation,
  SESSION_OBSERVATION_SCHEMA_VERSION,
  type SessionObservation,
  writeSessionObservation,
} from "./observation.js";

/**
 * Which repositories a session's file changes are looked for in: the roster
 * the workspace declares, resolved against the store's own root.
 *
 * `repos` (not `import.source_roots`) is the roster: source roots also carry
 * non-git entries such as the workspace view, and a view is a directory of
 * symlinks with no git of its own. A workspace that declares no roster is
 * observed in its own repository only.
 */
export function observedRepoRoots(root: string, manifest: Manifest): string[] {
  const declared = manifest.repos ?? [];
  const roots = declared.length > 0 ? declared.map((repo) => resolve(root, repo.path)) : [root];
  return [...new Set(roots)];
}

/** Inputs shared by the two observation passes. */
export type ObserveSessionInput = {
  /** `.basou/observations` of the workspace the session belongs to. */
  observationsDir: string;
  /** Absolute git repository roots to observe. */
  repoRoots: readonly string[];
  /** The vendor's session id (Claude Code's `session_id`). */
  externalId: string;
  /** Timestamp to stamp the observation with. */
  nowIso: string;
};

/**
 * Record where each repository stood when the session started, so a later pass
 * can ask git what changed since. Without this, "what did this session change"
 * has no base to be measured from, and the only remaining answer would be a
 * time window over commits — which attributes by proximity rather than by
 * observation, and this product has already rejected that once.
 *
 * Re-entrant by design: a SessionStart that fires again for the SAME session id
 * (a resume, a compaction) must NOT re-baseline, or every commit the session
 * has already made would drop out of its own record. An existing observation is
 * therefore left exactly as it is.
 *
 * Returns the observation in force after the call, or `null` when nothing could
 * be observed (no repository among `repoRoots` was readable).
 */
export async function recordSessionBaseline(
  input: ObserveSessionInput,
): Promise<SessionObservation | null> {
  const existing = await readSessionObservation(input.observationsDir, input.externalId);
  if (existing !== null) return existing;

  const repos: ObservedRepo[] = [];
  for (const repoRoot of input.repoRoots) {
    let baseHead: string | null;
    try {
      baseHead = await readHeadSha(repoRoot);
    } catch {
      continue; // not a repository (or git is missing) => nothing to observe here
    }
    // Everything already dirty is the operator's, not this session's. Recording
    // it now is what lets the later pass subtract it.
    let baseDirty: string[] = [];
    try {
      baseDirty = (await getWorkingTreeChanges(repoRoot)).map(
        (change) => observedFileFrom(repoRoot, change).path,
      );
    } catch {
      // A status failure only costs precision: without it the session may
      // claim a file that was already dirty. Keep the repository observed.
    }
    repos.push({ path: repoRoot, base_head: baseHead, base_dirty: baseDirty, files: [] });
  }
  if (repos.length === 0) return null;

  const observation: SessionObservation = {
    schema_version: SESSION_OBSERVATION_SCHEMA_VERSION,
    external_id: input.externalId,
    started_at: input.nowIso,
    updated_at: input.nowIso,
    repos,
  };
  await writeSessionObservation(input.observationsDir, observation);
  return observation;
}

/**
 * Recompute what the session has changed so far, against the baseline recorded
 * at its start, and persist the result.
 *
 * A FULL recomputation, not an accumulation: `git diff <base>` already answers
 * "net change since the session started" for tracked files, committed or not,
 * so there is nothing to merge across turns and no way for the two halves to
 * disagree. A file that was changed and then reverted correctly disappears.
 *
 * Per repository, a failure keeps that repository's PREVIOUS file list rather
 * than clearing it: the common cause is a base commit that no longer resolves
 * (a rebase, a reset), and forgetting what was already observed would be a
 * silent loss where a stale list is merely old.
 *
 * Returns `null` when the session has no baseline — it started before the hook
 * was installed, or outside a registered workspace — because inventing one now
 * would measure from the middle of the work.
 */
export async function observeSessionChanges(
  input: Omit<ObserveSessionInput, "repoRoots">,
): Promise<SessionObservation | null> {
  const existing = await readSessionObservation(input.observationsDir, input.externalId);
  if (existing === null) return null;

  const repos: ObservedRepo[] = [];
  for (const repo of existing.repos) {
    let files: ObservedFile[];
    try {
      files = await changedSinceBaseline(repo, existing.started_at);
    } catch {
      repos.push(repo); // keep what was already observed
      continue;
    }
    repos.push({ ...repo, files });
  }

  const updated: SessionObservation = { ...existing, updated_at: input.nowIso, repos };
  await writeSessionObservation(input.observationsDir, updated);
  return updated;
}

/**
 * Whether a repository-relative path belongs to basou's own store.
 *
 * The store is basou writing about the session, not the session's work — and
 * this very observation is a file inside it, so without this a session that
 * changed nothing would still report `.basou/observations/<its own id>.json`.
 * Most workspaces ignore `.basou/` in git and never reach this, but the ones
 * that do not must not have their sessions narrate basou's bookkeeping back to
 * them.
 */
function isBasouStorePath(relativePath: string): boolean {
  return relativePath === ".basou" || relativePath.startsWith(".basou/");
}

/**
 * Net change of one repository since the session's baseline: git's own answer
 * for tracked files, limited to what this repository's own activity touched,
 * plus the untracked files git's diff never reports, minus what was already
 * dirty before the session began.
 */
async function changedSinceBaseline(
  repo: ObservedRepo,
  startedAt: string,
): Promise<ObservedFile[]> {
  const byPath = new Map<string, ObservedFile>();

  // A repository with no commits at session start still has a base: the empty
  // tree. Skipping the diff there would leave only the working tree, and a
  // session that commits everything it wrote ends with a clean one — reporting
  // nothing, which is the silence this whole mechanism exists to end.
  const base = repo.base_head ?? (await readEmptyTreeSha(repo.path));
  const own = await ownActivityPaths(repo, startedAt);
  for (const change of await getChangesSince(repo.path, base)) {
    if (isBasouStorePath(change.path)) continue;
    if (own !== null && !touchedBy(own, change.path, change.old_path)) continue;
    const file = observedFileFrom(repo.path, change);
    byPath.set(file.path, file);
  }

  // UNTRACKED files only. Every tracked path is already answered above,
  // relative to the baseline, which the working tree alone cannot express in
  // either direction: a file added then committed is `added` since the base
  // rather than absent, and a file committed then restored to its base content
  // is nothing since the base even though the working tree still differs from
  // HEAD. Adding every working-tree entry here would re-report the second as a
  // change that, net, was never made.
  for (const change of await getUntrackedFiles(repo.path)) {
    if (isBasouStorePath(change.path)) continue;
    const file = observedFileFrom(repo.path, change);
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }

  const preexisting = new Set(repo.base_dirty);
  return [...byPath.values()]
    .filter((file) => !preexisting.has(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Repository-relative paths the repository's OWN activity touched since the
 * session started: every path a commit created here in that time changed (see
 * {@link getOwnCommitPaths}), plus every tracked path that differs from HEAD
 * right now. The net change since the base is limited to these, so a commit
 * that arrived by a pull or a fast-forward merge -- written elsewhere, by
 * someone else or by a bot -- is not charged to the session, while the
 * session's own commits still are after they come back from a squash merge,
 * because it created them here first.
 *
 * `null` means "cannot tell": the reflog is unreadable, or HEAD moved while the
 * reflog recorded nothing (reflogs off or expired). The caller then keeps every
 * net change, since dropping the session's work silently would be worse than
 * over-reporting it.
 */
async function ownActivityPaths(
  repo: ObservedRepo,
  startedAt: string,
): Promise<Set<string> | null> {
  const sinceMs = Date.parse(startedAt);
  if (Number.isNaN(sinceMs)) return null;
  try {
    const commits = await getOwnCommitPaths(repo.path, sinceMs);
    if (commits === null) return null;
    const head = await readHeadSha(repo.path);
    if (commits.entriesSince === 0 && head !== repo.base_head) return null;
    const own = new Set(commits.paths);
    const uncommittedBase = head ?? (await readEmptyTreeSha(repo.path));
    for (const change of await getChangesSince(repo.path, uncommittedBase)) {
      own.add(change.path);
      if (change.old_path !== undefined) own.add(change.old_path);
    }
    return own;
  } catch {
    return null;
  }
}

/** Whether a change (or, for a rename, either of its names) is among `own`. */
function touchedBy(own: ReadonlySet<string>, path: string, oldPath: string | undefined): boolean {
  return own.has(path) || (oldPath !== undefined && own.has(oldPath));
}
