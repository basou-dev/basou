import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FileChange } from "../git/diff.js";
import { atomicReplace } from "../storage/atomic.js";

/**
 * On-disk shape of a session observation. Deliberately NOT one of the durable
 * schemas under `schemas/`: an observation is working state that exists only
 * between a session's start and the import that consumes it, never a
 * provenance record. The record is the `file_changed` event the import writes;
 * this file is the scratch the hooks accumulate it in, and a reader that
 * cannot parse it must be able to drop it and lose nothing but one session's
 * file list. That is why the version below is checked but unversioned in the
 * repository's schema-artifact machinery, and why every read path returns
 * `null` instead of throwing.
 */
export const SESSION_OBSERVATION_SCHEMA_VERSION = "0.1.0" as const;

/** How long an unconsumed observation is kept before it is pruned. */
export const SESSION_OBSERVATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ObservedFileSchema = z.object({
  /** Absolute path, matching the paths the transcript importer records. */
  path: z.string().min(1),
  change_type: z.enum(["added", "modified", "deleted", "renamed"]),
  old_path: z.string().min(1).optional(),
});

const ObservedRepoSchema = z.object({
  /** Absolute path of the git repository root this entry speaks for. */
  path: z.string().min(1),
  /**
   * `HEAD` as it stood when the session started. `null` when the repository
   * had no commits yet (a fresh `git init`), in which case only working-tree
   * changes are observable.
   */
  base_head: z.string().nullable(),
  /**
   * Paths already dirty at session start. They are SUBTRACTED from the
   * working-tree observation: a file the operator left modified before the
   * session opened was not changed BY this session, and attributing it would
   * make the first session after any interrupted work claim the interruption.
   */
  base_dirty: z.array(z.string()).default([]),
  /** Latest full recomputation for this repository (see `observeSession`). */
  files: z.array(ObservedFileSchema).default([]),
});

const SessionObservationSchema = z.object({
  schema_version: z.string().min(1),
  external_id: z.string().min(1),
  started_at: z.string().min(1),
  updated_at: z.string().min(1),
  repos: z.array(ObservedRepoSchema).default([]),
});

/** A file this session changed, as observed through git. */
export type ObservedFile = z.infer<typeof ObservedFileSchema>;
/** Per-repository half of a {@link SessionObservation}. */
export type ObservedRepo = z.infer<typeof ObservedRepoSchema>;
/** What the hooks accumulated for one vendor session, keyed by its external id. */
export type SessionObservation = z.infer<typeof SessionObservationSchema>;

/**
 * Only these characters may appear in an external id used as a filename. The
 * id comes from a vendor payload (Claude Code's `session_id`), so it is
 * untrusted input on a path: anything outside this set — a separator, a dot
 * segment, a NUL — is refused rather than escaped, because no legitimate
 * vendor id needs it.
 */
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Path of the observation file for `externalId`, or `null` when the id could
 * address something other than a file in `observationsDir`.
 */
export function sessionObservationPath(observationsDir: string, externalId: string): string | null {
  if (!SAFE_EXTERNAL_ID.test(externalId)) return null;
  if (externalId === "." || externalId === "..") return null;
  return join(observationsDir, `${externalId}.json`);
}

/**
 * Read one observation. Returns `null` for every failure mode — absent,
 * unreadable, malformed, or written by a future version — because a caller
 * that cannot read the scratch must fall back to "no observation", never to an
 * error that would break a hook or an import.
 */
export async function readSessionObservation(
  observationsDir: string,
  externalId: string,
): Promise<SessionObservation | null> {
  const file = sessionObservationPath(observationsDir, externalId);
  if (file === null) return null;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = SessionObservationSchema.safeParse(parsed);
  if (!result.success) return null;
  if (result.data.schema_version !== SESSION_OBSERVATION_SCHEMA_VERSION) return null;
  return result.data;
}

/**
 * Write one observation atomically. The caller owns the decision to write; a
 * failure propagates so the hook wrapper can swallow it in one place.
 */
export async function writeSessionObservation(
  observationsDir: string,
  observation: SessionObservation,
): Promise<void> {
  const file = sessionObservationPath(observationsDir, observation.external_id);
  if (file === null) return;
  // The directory is created here rather than by `ensureBasouDirectory`
  // alone: every store initialized before observations existed lacks it, and
  // a hook must work in those without an init step.
  await mkdir(observationsDir, { recursive: true });
  await atomicReplace(file, `${JSON.stringify(observation, null, 2)}\n`);
}

/**
 * Flatten an observation into the file list an importer consumes: repository
 * order, then path order, with duplicates across repositories impossible
 * because the paths are absolute.
 */
export function observedFilesOf(observation: SessionObservation): ObservedFile[] {
  const files: ObservedFile[] = [];
  for (const repo of observation.repos) files.push(...repo.files);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Drop observations older than {@link SESSION_OBSERVATION_TTL_MS}. Best-effort
 * housekeeping so an unconsumed scratch file (a session whose transcript was
 * never imported) cannot accumulate without bound; every error is ignored
 * because failing to prune is never worth failing the caller.
 */
export async function pruneSessionObservations(
  observationsDir: string,
  nowMs: number,
  ttlMs: number = SESSION_OBSERVATION_TTL_MS,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(observationsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(observationsDir, entry);
    try {
      const info = await stat(file);
      if (nowMs - info.mtimeMs > ttlMs) await unlink(file);
    } catch {
      // Ignore: a file that vanished or cannot be stat'd needs no pruning.
    }
  }
}

/** Convert a git {@link FileChange} into the observation's file shape. */
export function observedFileFrom(repoRoot: string, change: FileChange): ObservedFile {
  return {
    path: join(repoRoot, change.path),
    change_type: change.status,
    ...(change.old_path !== undefined ? { old_path: join(repoRoot, change.old_path) } : {}),
  };
}
