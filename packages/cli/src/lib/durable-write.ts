import { randomUUID } from "node:crypto";
import { lstat, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Throw if `targetPath` is a symlink. Returns silently when the path is a
 * regular file or does not exist.
 *
 * Writing through a symlink would let a link at the target redirect the write
 * to an unexpected file. The protocol channel writes into a user-owned config
 * file and refuses symlinked targets by default (mirroring the `.basou/` root
 * invariant, which also rejects a symlink in its place). `lstat` does not
 * follow the link, so a symlink is detected as such.
 */
export async function assertNotSymlink(targetPath: string): Promise<void> {
  try {
    const st = await lstat(targetPath);
    if (st.isSymbolicLink()) {
      throw new Error(
        "Refusing to write through a symlink. Replace the symlinked target with a regular file (or remove it) and retry.",
      );
    }
  } catch (error: unknown) {
    if (error instanceof Error && (error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Durably write `content` to `targetPath`, preserving the existing file's
 * permission bits and fsyncing both the file and its directory.
 *
 * In addition to a tmp + rename atomic swap, the file contents are fsynced
 * before the rename and the parent directory is fsynced after, so a crash or
 * power loss leaves either the old file or the fully-written new one (never a
 * truncated file), and the rename itself survives. The new file inherits the
 * mode of the file it replaces (default 0o644 when the target does not yet
 * exist) rather than whatever the umask would impose. Directory fsync is
 * best-effort: platforms that reject an fsync on a directory fd do not fail the
 * write (the contents are already durable via the file fsync and the atomic
 * rename).
 *
 * Intended for writing into a user-owned config file (e.g. ~/.claude/CLAUDE.md)
 * where durability and mode preservation matter. The tmp file is created with
 * the `wx` flag in the same directory so the rename cannot cross filesystems
 * and never clobbers a concurrent tmp file. The caller is responsible for
 * refusing symlinked targets (see {@link assertNotSymlink}); this helper
 * replaces the name via rename and does not follow a symlink at `targetPath`.
 */
export async function writeFileDurable(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath);
  const tmpPath = join(dir, `.${basename(targetPath)}.tmp.${randomUUID()}`);

  let mode = 0o644;
  try {
    mode = (await stat(targetPath)).mode & 0o777;
  } catch (error: unknown) {
    if (!(error instanceof Error && (error as { code?: string }).code === "ENOENT")) {
      throw error;
    }
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmpPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmpPath, targetPath);
  } catch (error: unknown) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }

  // Best-effort directory fsync so the rename is durable across power loss.
  try {
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Some platforms reject fsync on a directory fd; the file content is
    // already durable and the rename is atomic, so do not fail the write.
  }
}
