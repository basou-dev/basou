import { randomUUID } from "node:crypto";
// Namespace import keeps lstat / readFile / writeFile / rename / unlink
// behind a single binding for symmetry. The EACCES test exercises this
// module via real fs + chmod on the parent directory rather than vi.spyOn,
// because vi.spyOn cannot redefine ESM module exports under vitest 2.x.
import * as fsp from "node:fs/promises";
import type { Manifest } from "../schemas/manifest.schema.js";
import { StatusSchema, type StatusSnapshot } from "../schemas/status.schema.js";
import type { BasouPaths } from "./basou-dir.js";

/**
 * @internal Compile-time exhaustiveness via Record: every key of
 * `StatusSnapshot["directories_present"]` MUST have a paths accessor here,
 * otherwise the file fails to typecheck. Run-time exhaustiveness is
 * verified by status.test.ts (key-set equality with
 * `StatusSchema.shape.directories_present.shape`). Exported only so the
 * test can perform that equality check; not part of the public API.
 */
export const DIRECTORY_CHECKS: Record<
  keyof StatusSnapshot["directories_present"],
  (p: BasouPaths) => string
> = {
  sessions: (p) => p.sessions,
  tasks: (p) => p.tasks,
  approvals_pending: (p) => p.approvals.pending,
  approvals_resolved: (p) => p.approvals.resolved,
  logs: (p) => p.logs,
  raw: (p) => p.raw,
  tmp: (p) => p.tmp,
};

/**
 * Refuse to operate on `.basou` if it is a symlink or not a directory. This
 * prevents `writeStatus` from being tricked into writing `status.json`
 * outside the repository root via a swapped `.basou` symlink. Mirrors
 * `ensureBasouDirectory`'s lstat-based guard.
 *
 * If `.basou` is absent the underlying ENOENT is propagated (wrapped) so
 * callers can map it to "workspace not initialized" via `findErrorCode`.
 *
 * Note: this is a baseline safety net, not a TOCTOU fix — the directory
 * could still be replaced between this check and the subsequent write. The
 * goal is to detect already-swapped symlinks, not to race-proof the
 * filesystem.
 */
export async function assertBasouRootSafe(rootPath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(rootPath);
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") {
      throw new Error("Basou workspace not found", { cause: error });
    }
    throw new Error("Failed to inspect .basou root", { cause: error });
  }
  if (stat.isSymbolicLink()) {
    throw new Error(".basou root is a symlink; refusing to operate");
  }
  if (!stat.isDirectory()) {
    throw new Error(".basou root exists but is not a directory");
  }
}

/**
 * Probe whether `path` is a directory using `lstat` (without following
 * symlinks, so a symlink-to-directory is reported as `false`).
 *
 * Only ENOENT and ENOTDIR are mapped to `false`; permission-style errors
 * (EACCES, EPERM, ...) are re-thrown so a misleading "not present" answer
 * is never written into status.json. This keeps the snapshot honest about
 * what was actually observed.
 */
async function dirPresent(path: string): Promise<boolean> {
  try {
    return (await fsp.lstat(path)).isDirectory();
  } catch (error: unknown) {
    if (hasErrorCode(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw new Error("Failed to inspect .basou subdirectory", { cause: error });
  }
}

/**
 * Build a StatusSnapshot from a manifest plus the path layout, observing
 * each subdirectory's presence via `lstat`. Read-only with respect to the
 * workspace state; writes nothing. The result is re-validated by
 * `StatusSchema.parse` before being returned.
 *
 * @param input.now Override for testing; defaults to `new Date()`.
 */
export async function buildStatusSnapshot(input: {
  manifest: Manifest;
  paths: BasouPaths;
  now?: Date;
}): Promise<StatusSnapshot> {
  const { manifest, paths } = input;
  const generatedAt = (input.now ?? new Date()).toISOString();

  const entries = Object.entries(DIRECTORY_CHECKS) as Array<
    [keyof StatusSnapshot["directories_present"], (p: BasouPaths) => string]
  >;
  const presence = await Promise.all(
    entries.map(async ([key, get]) => [key, await dirPresent(get(paths))] as const),
  );
  const directoriesEntries = Object.fromEntries(presence) as StatusSnapshot["directories_present"];

  const snapshot: StatusSnapshot = {
    schema_version: "0.1.0",
    generated_at: generatedAt,
    workspace: {
      id: manifest.workspace.id,
      name: manifest.workspace.name,
      basou_version: manifest.basou_version,
    },
    directories_present: directoriesEntries,
  };
  return StatusSchema.parse(snapshot);
}

/**
 * Atomically write a StatusSnapshot to `paths.files.status`.
 *
 * Re-validates via `StatusSchema.parse` before any file I/O, so an invalid
 * snapshot throws synchronously and never overwrites the existing
 * `status.json`. The atomic strategy mirrors `writeYamlFile`: write to a
 * uniquely-named tmp file in the same directory with the `wx` flag, then
 * `rename` over the destination so a crash never leaves a partial JSON.
 *
 * **Precondition**: callers MUST invoke {@link assertBasouRootSafe} on
 * `paths.root` first to ensure `.basou` is a real directory and not a
 * swapped symlink. `writeStatus` does not redo this guard — it trusts the
 * caller — so a direct invocation without the guard could write
 * `status.json` outside the repository root.
 */
export async function writeStatus(paths: BasouPaths, snapshot: StatusSnapshot): Promise<void> {
  const validated = StatusSchema.parse(snapshot);
  const body = `${JSON.stringify(validated, null, 2)}\n`;
  const tmpPath = `${paths.files.status}.tmp.${randomUUID()}`;
  try {
    await fsp.writeFile(tmpPath, body, { encoding: "utf8", flag: "wx" });
    await fsp.rename(tmpPath, paths.files.status);
  } catch (error: unknown) {
    await fsp.unlink(tmpPath).catch(() => undefined);
    throw new Error("Failed to write status file", { cause: error });
  }
}

/**
 * Read `.basou/status.json` for the current schema_version (0.1.0). This
 * is a cache reader only; cross-version migration is not supported here.
 * Older or newer status.json shapes will fail `StatusSchema.parse` —
 * callers regenerate by calling `buildStatusSnapshot` + `writeStatus`.
 */
export async function readStatus(paths: BasouPaths): Promise<StatusSnapshot> {
  let body: string;
  try {
    body = await fsp.readFile(paths.files.status, "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") {
      throw new Error("Status file not found", { cause: error });
    }
    throw new Error("Failed to read status file", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error: unknown) {
    throw new Error("Failed to parse status JSON", { cause: error });
  }
  return StatusSchema.parse(parsed);
}

/**
 * Walk the cause chain (up to `depth` levels) looking for an Error whose
 * errno-style `code` matches `code`. Returns true on the first match.
 * Resilient to wrapper depth changes so that ENOENT detection survives
 * future error-wrapping refactors.
 */
export function findErrorCode(error: unknown, code: string, depth = 4): boolean {
  let cur: unknown = error;
  for (let i = 0; i < depth && cur instanceof Error; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && c === code) return true;
    cur = (cur as Error).cause;
  }
  return false;
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  return typeof (error as unknown as Record<string, unknown>).code === "string";
}
