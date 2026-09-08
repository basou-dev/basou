import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Markers,
  ORIENTATION_END,
  ORIENTATION_START,
  parseMarkers,
  readMarkdownFile,
  removeMarkerSection,
} from "@basou/core";
import { assertNotSymlink, writeFileDurable } from "./durable-write.js";

/**
 * The "context channel": basou renders marker-delimited managed blocks into the
 * files an AI coding tool auto-loads at session start. Today that is the
 * standing-protocol block in Claude Code's user-global CLAUDE.md (see
 * `protocols-config`). The orientation block that used to be rendered into
 * Codex's user-global AGENTS.md is retired: that file is read by every project's
 * Codex, so whatever one workspace wrote there sat in the context of every other
 * workspace's next session. A position now reaches Codex through its
 * SessionStart hook (`basou hook install codex`), which computes it from the
 * session's own cwd and stores nothing. What remains here for that face is the
 * ability to REMOVE a block an older basou left behind (`basou channel clear
 * codex`).
 *
 * Face paths are HARD-CODED, never config-driven, for the same reason the
 * protocol target is locked: a config-supplied path would let basou append to
 * arbitrary files. `target` overrides on the functions below exist for tests.
 */

/**
 * Codex's user-global AGENTS.md. Codex auto-loads it at startup for every
 * project on the machine. basou no longer writes to it; the path is kept so
 * `basou channel clear codex` can remove an orientation block rendered there by
 * an earlier basou (0.39 or before).
 */
export const CODEX_TARGET_PATH = join(homedir(), ".codex", "AGENTS.md");

const ORIENTATION_MARKERS: Markers = { start: ORIENTATION_START, end: ORIENTATION_END };

export type BlockSyncAction = "installed" | "updated" | "unchanged";
export type BlockSyncResult = { action: BlockSyncAction };

/**
 * Compute the new target body for a managed marker block. The target is a
 * foreign file that may already hold user content with no basou block yet, so
 * the no-markers case APPENDS rather than throwing.
 *
 * - target absent/empty: file is just the wrapped block (a freshly-touched file
 *   does not gain spurious leading blank lines from the append path).
 * - existing has an `ok` block: replace it in place (preserve before/after).
 * - existing has no block: append the block to the end (preserve all content).
 * - existing has a malformed block: refuse (do not silently rewrite).
 */
function buildTargetBody(existing: string | null, block: string, markers: Markers): string {
  const wrapped = `${markers.start}\n${block}${markers.end}\n`;
  if (existing === null || existing === "") return wrapped;
  const section = parseMarkers(existing, markers);
  switch (section.kind) {
    case "ok":
      return `${section.before}${markers.start}\n${block}${markers.end}${section.after}`;
    case "no_markers": {
      const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      return `${existing}${sep}${wrapped}`;
    }
    default:
      throw new Error(
        "The basou-managed markers in the target are malformed (a marker is missing, duplicated, or out of order). Fix or remove them, then retry.",
      );
  }
}

/**
 * Back up the target's original content the first time basou modifies it.
 * Uses a single stable `<target>.basou-bak` and never overwrites it, so the
 * pre-basou original is preserved exactly once.
 *
 * When the target did not exist, the pre-basou original is NOTHING, and that is
 * recorded as an empty backup rather than skipped. Skipping left the door open
 * for the next write — whose `existing` is basou's own block — to be backed up
 * as the "original" and kept forever, so a workspace's position survived on
 * disk after the block itself was cleared. `readMarkdownFile` returns "" for an
 * empty file (null only when absent), so the empty backup is honoured as
 * "already taken" from then on.
 */
async function backupOnce(target: string, existing: string | null): Promise<void> {
  const bak = `${target}.basou-bak`;
  const already = await readMarkdownFile(bak);
  if (already !== null) return;
  await writeFileDurable(bak, existing ?? "");
}

/**
 * Render a marker-delimited managed block into a foreign auto-load file,
 * touching only the bytes between `markers`. Append-if-absent / replace-if-
 * present / refuse-if-malformed, with a one-time `<target>.basou-bak` of the
 * pre-basou original and an optimistic-concurrency recheck before writing.
 * Used by the protocol channel; the retired orientation channel used it too.
 */
export async function syncMarkerBlock(opts: {
  target: string;
  markers: Markers;
  /** Inner block body WITHOUT the marker lines. */
  block: string;
  dryRun?: boolean;
}): Promise<BlockSyncResult> {
  const { target, markers, block } = opts;
  await assertNotSymlink(target);
  const existing = await readMarkdownFile(target);
  const newBody = buildTargetBody(existing, block, markers);
  if (newBody === existing) return { action: "unchanged" };

  const hadBlock = existing !== null && parseMarkers(existing, markers).kind === "ok";
  const action: BlockSyncAction = hadBlock ? "updated" : "installed";
  if (opts.dryRun === true) return { action };

  // Optimistic concurrency: re-read and abort if the file changed since the
  // read above, so a concurrent edit is not clobbered. This narrows but does
  // not fully close the window; hard exclusion would need a lock.
  const recheck = await readMarkdownFile(target);
  if (recheck !== existing) {
    throw new Error(
      "The target changed during sync; aborting so a concurrent edit is not overwritten. Re-run the command.",
    );
  }
  // Back up only after the CAS check passes, so an aborted run never leaves a
  // backup of a file it did not modify.
  await backupOnce(target, existing);
  await writeFileDurable(target, newBody);
  return { action };
}

/**
 * Refuse a block body that contains a marker line. A marker inside the body
 * would be mistaken for the block delimiter on the next parse and corrupt the
 * managed block, so the protocol channel (operator-authored sources) screens
 * for it before writing.
 */
export function assertNoMarkerLine(body: string, markers: Markers): void {
  for (const line of body.split(/\r?\n/)) {
    if (line === markers.start || line === markers.end) {
      throw new Error(
        "The content contains a basou marker line, which would corrupt the managed block. Remove that line from the source.",
      );
    }
  }
}

/**
 * Remove a managed marker block from `target`. Returns whether anything changed.
 * `backup: false` skips the one-time `.basou-bak`: a caller whose purpose is to
 * get a block OFF the machine must not leave a copy of it beside the target.
 */
export async function removeMarkerBlock(opts: {
  target: string;
  markers: Markers;
  fileLabel: string;
  dryRun?: boolean;
  backup?: boolean;
}): Promise<{ removed: boolean }> {
  const { target, markers, fileLabel } = opts;
  await assertNotSymlink(target);
  const existing = await readMarkdownFile(target);
  if (existing === null) return { removed: false };
  const newBody = removeMarkerSection(existing, fileLabel, markers);
  if (newBody === existing) return { removed: false };
  if (opts.dryRun === true) return { removed: true };

  const recheck = await readMarkdownFile(target);
  if (recheck !== existing) {
    throw new Error(
      "The target changed during unsync; aborting so a concurrent edit is not overwritten. Re-run the command.",
    );
  }
  if (opts.backup !== false) await backupOnce(target, existing);
  await writeFileDurable(target, newBody);
  return { removed: true };
}

/**
 * Remove the orientation block from the Codex context face, leaving any other
 * content of the file (a hand-written body, the protocol block) untouched. The
 * face is user-global, so a block an earlier basou (0.39 or before) rendered there is in the
 * context of every Codex session on the machine until something removes it —
 * nothing in basou overwrites it any more, so this is the way it leaves. No
 * `.basou-bak` is written by this path. `target` overrides the locked path for
 * tests only.
 */
export async function clearOrientationChannel(opts: {
  target?: string;
  dryRun?: boolean;
}): Promise<{ removed: boolean }> {
  return removeMarkerBlock({
    target: opts.target ?? CODEX_TARGET_PATH,
    markers: ORIENTATION_MARKERS,
    // Name the file actually acted on, so an error under the test seam does not
    // point at the locked path.
    fileLabel: opts.target ?? "~/.codex/AGENTS.md",
    // The block is being removed because it should not be on this machine;
    // preserving it in `.basou-bak` would defeat the command.
    backup: false,
    ...(opts.dryRun === true ? { dryRun: true } : {}),
  });
}
