import { randomUUID } from "node:crypto";
import { link, rename, unlink, writeFile } from "node:fs/promises";

/**
 * Atomically create a new file at `targetPath` via tmp + link.
 *
 * Strategy: write the body to a sibling tmp file (`${targetPath}.tmp.<uuid>`)
 * with the `wx` flag, then `link()` the tmp inode into place at `targetPath`.
 * If the target already exists, `link` fails with EEXIST — callers detect this
 * via `findErrorCode(error, "EEXIST")` to surface a domain-specific
 * "already exists" message.
 *
 * The tmp file lives in the SAME directory as the target so `link` cannot
 * fail with EXDEV. On every code path (success and failure) the tmp inode
 * is best-effort unlinked, so after a successful call the tmp side of the
 * hard-link pair is removed and only `targetPath` remains.
 *
 * The native fs error is re-thrown WITHOUT wrapping so callers can attach
 * their own pathless message via `new Error("<fixed msg>", { cause })`. The
 * caller is responsible for the final error vocabulary (pathless contract).
 */
export async function atomicCreate(targetPath: string, content: string | Buffer): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
    await link(tmpPath, targetPath);
  } catch (error: unknown) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
  // tmp inode is now linked twice (tmp + target); unlink the tmp side so
  // disk does not carry a spurious sibling after a successful create.
  await unlink(tmpPath).catch(() => undefined);
}

/**
 * Atomically replace the file at `targetPath` via tmp + rename.
 *
 * Strategy: write the body to a sibling tmp file (`${targetPath}.tmp.<uuid>`)
 * with the `wx` flag, then `rename()` the tmp over `targetPath`. Silently
 * overwrites any existing file at `targetPath`. The tmp file lives in the
 * SAME directory as the target so `rename` cannot fail with EXDEV. `rename`
 * consumes the tmp file, so no post-success cleanup is needed.
 *
 * On failure the tmp file is best-effort unlinked so disk never carries a
 * half-written rename source. The native fs error is re-thrown WITHOUT
 * wrapping so callers can attach their own pathless message.
 */
export async function atomicReplace(targetPath: string, content: string | Buffer): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, targetPath);
  } catch (error: unknown) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
