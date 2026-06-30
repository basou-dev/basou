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
 * files each AI coding tool auto-loads at session start. This is the vendor-
 * neutral generalization of the protocol channel — the standing-protocol block
 * (Claude Code's SessionStart hook is just its dynamic, Claude-specific
 * counterpart) plus the orientation block, which is how a "where am I" reaches a
 * vendor that exposes no active SessionStart hook of its own.
 *
 * Face paths are HARD-CODED, never config-driven, for the same reason the
 * protocol target is locked: a config-supplied path would let basou append to
 * arbitrary files. `target` overrides on the functions below exist for tests.
 */

/**
 * Codex's user-global AGENTS.md. Codex auto-loads it at startup and exposes no
 * SessionStart-equivalent hook, so this static channel is the only vendor-
 * neutral active path by which orientation can reach an interactive Codex.
 * (Claude Code's locked target lives in protocols-config as DEFAULT_TARGET_PATH;
 * a face registry can fold both together once a second channel needs the list.)
 */
export const CODEX_TARGET_PATH = join(homedir(), ".codex", "AGENTS.md");

const ORIENTATION_MARKERS: Markers = { start: ORIENTATION_START, end: ORIENTATION_END };

/** Note rendered atop the orientation block so a reader knows it is regenerated, not hand-edited. */
const ORIENTATION_MANAGED_NOTE =
  "<!-- Managed by basou: 'basou refresh' regenerates everything between the BASOU:ORIENTATION markers with the workspace's current position. This block is transient — it changes every refresh; do not edit it. -->";

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
 */
async function backupOnce(target: string, existing: string | null): Promise<void> {
  if (existing === null) return;
  const bak = `${target}.basou-bak`;
  const already = await readMarkdownFile(bak);
  if (already !== null) return;
  await writeFileDurable(bak, existing);
}

/**
 * Render a marker-delimited managed block into a foreign auto-load file,
 * touching only the bytes between `markers`. Append-if-absent / replace-if-
 * present / refuse-if-malformed, with a one-time `<target>.basou-bak` of the
 * pre-basou original and an optimistic-concurrency recheck before writing.
 * Shared by the protocol channel and the orientation channel.
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
 * managed block, so both the protocol channel (operator-authored sources) and
 * the orientation channel (machine-generated body) screen for it first.
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

/** Remove a managed marker block from `target`. Returns whether anything changed. */
export async function removeMarkerBlock(opts: {
  target: string;
  markers: Markers;
  fileLabel: string;
  dryRun?: boolean;
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
  await backupOnce(target, existing);
  await writeFileDurable(target, newBody);
  return { removed: true };
}

/**
 * Render the current orientation body into the Codex context face
 * (~/.codex/AGENTS.md). This is the floor of the Codex adapter: a vendor-neutral
 * "where am I" reaches Codex, which exposes no SessionStart hook. `target` is
 * overridable for tests only; default is the locked {@link CODEX_TARGET_PATH}.
 *
 * The orientation body is machine-generated, so it should never contain a
 * marker line; a defensive scan refuses rather than corrupting the block on the
 * next parse (callers run this best-effort so a refuse never fails the refresh).
 */
export async function syncOrientationChannel(opts: {
  body: string;
  target?: string;
  dryRun?: boolean;
}): Promise<BlockSyncResult> {
  assertNoMarkerLine(opts.body, ORIENTATION_MARKERS);
  const block = `${ORIENTATION_MANAGED_NOTE}\n\n${opts.body.replace(/\s+$/, "")}\n`;
  return syncMarkerBlock({
    target: opts.target ?? CODEX_TARGET_PATH,
    markers: ORIENTATION_MARKERS,
    block,
    ...(opts.dryRun === true ? { dryRun: true } : {}),
  });
}
