import { readFile } from "node:fs/promises";
import {
  PROTOCOL_END,
  PROTOCOL_START,
  parseMarkers,
  readMarkdownFile,
  removeMarkerSection,
} from "@basou/core";
import type { Command } from "commander";
import { assertNotSymlink, writeFileDurable } from "../lib/durable-write.js";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import {
  DEFAULT_PROTOCOLS_CONFIG_PATH,
  DEFAULT_TARGET_PATH,
  loadProtocolsConfig,
  type ProtocolEntry,
} from "../lib/protocols-config.js";

/** Marker pair that delimits the basou-managed protocol block in the target. */
const PROTOCOL_MARKERS = { start: PROTOCOL_START, end: PROTOCOL_END };

/** Note rendered at the top of the managed block so a reader knows not to edit it. */
const MANAGED_NOTE =
  "<!-- Managed by basou: 'basou protocol sync' regenerates everything between the BASOU:PROTOCOLS markers from ~/.basou/protocols.yaml. Manual edits inside the block are overwritten; edit the source files instead. -->";

export type ProtocolCommonOptions = {
  config?: string;
  target?: string;
  verbose?: boolean;
};

export type ProtocolSyncOptions = ProtocolCommonOptions & { dryRun?: boolean };

/**
 * Wire `basou protocol` (sync / list / unsync) onto `program`. The command
 * renders operator-declared standing protocols into a marker-delimited block
 * inside the user-global Claude Code instructions file (~/.claude/CLAUDE.md),
 * which Claude Code auto-loads every session. It only ever touches the bytes
 * between the BASOU:PROTOCOLS markers; everything else in the file is preserved.
 */
export function registerProtocolCommand(program: Command): void {
  const protocol = program
    .command("protocol")
    .description("Manage the basou-managed standing-protocol block in the global CLAUDE.md");

  protocol
    .command("sync")
    .description("Render declared protocols into the global CLAUDE.md (creates/updates the block)")
    .option("--config <path>", "Path to protocols.yaml (default ~/.basou/protocols.yaml)")
    .option("--target <path>", "Override the target file (intended for tests)")
    .option("--dry-run", "Print what would change without writing")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProtocolSyncOptions) => {
      await runProtocolSync(opts);
    });

  protocol
    .command("list")
    .description("List declared protocols and whether the block is installed")
    .option("--config <path>", "Path to protocols.yaml (default ~/.basou/protocols.yaml)")
    .option("--target <path>", "Override the target file (intended for tests)")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProtocolCommonOptions) => {
      await runProtocolList(opts);
    });

  protocol
    .command("unsync")
    .description("Remove the basou-managed protocol block from the global CLAUDE.md")
    .option("--target <path>", "Override the target file (intended for tests)")
    .option("--dry-run", "Print what would change without writing")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProtocolSyncOptions) => {
      await runProtocolUnsync(opts);
    });
}

export async function runProtocolSync(options: ProtocolSyncOptions): Promise<void> {
  try {
    await doRunProtocolSync(options);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function runProtocolList(options: ProtocolCommonOptions): Promise<void> {
  try {
    await doRunProtocolList(options);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function runProtocolUnsync(options: ProtocolSyncOptions): Promise<void> {
  try {
    await doRunProtocolUnsync(options);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Read each protocol source and refuse if a source body contains a marker line
 * (which would corrupt the managed block on the next parse). Returns the
 * entries paired with their file contents, in declared order.
 */
async function readProtocolSources(
  entries: ProtocolEntry[],
): Promise<{ entry: ProtocolEntry; content: string }[]> {
  const out: { entry: ProtocolEntry; content: string }[] = [];
  for (const entry of entries) {
    let content: string;
    try {
      content = await readFile(entry.source, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && (error as { code?: string }).code === "ENOENT") {
        throw new Error(
          "A protocol source file does not exist. Check the 'source' paths in ~/.basou/protocols.yaml.",
          { cause: error },
        );
      }
      throw new Error("Failed to read a protocol source file.", { cause: error });
    }
    for (const line of content.split(/\r?\n/)) {
      if (line === PROTOCOL_START || line === PROTOCOL_END) {
        throw new Error(
          "A protocol source contains a BASOU:PROTOCOLS marker line, which would corrupt the managed block. Remove that line from the source.",
        );
      }
    }
    out.push({ entry, content });
  }
  return out;
}

/** Assemble the inner block body (without the markers) from the read sources. */
function buildBlock(sources: { entry: ProtocolEntry; content: string }[]): string {
  const sections = sources.map(({ entry, content }) => {
    const body = content.replace(/\s+$/, "");
    return entry.title !== undefined ? `## ${entry.title}\n\n${body}` : body;
  });
  return `${MANAGED_NOTE}\n\n${sections.join("\n\n")}\n`;
}

/**
 * Compute the new target body. Unlike the basou-owned generated files, the
 * target is a foreign file that may already hold user content with no basou
 * block yet, so the no-markers case APPENDS rather than throwing.
 *
 * - target absent: file is just the wrapped block.
 * - existing has an `ok` block: replace it in place (preserve before/after).
 * - existing has no block: append the block to the end (preserve all content).
 * - existing has a malformed block: refuse (do not silently rewrite).
 */
function buildTargetBody(existing: string | null, block: string): string {
  const wrapped = `${PROTOCOL_START}\n${block}${PROTOCOL_END}\n`;
  // An empty existing file is treated like an absent one, so a freshly-touched
  // CLAUDE.md does not gain spurious leading blank lines from the append path.
  if (existing === null || existing === "") return wrapped;
  const section = parseMarkers(existing, PROTOCOL_MARKERS);
  switch (section.kind) {
    case "ok":
      return `${section.before}${PROTOCOL_START}\n${block}${PROTOCOL_END}${section.after}`;
    case "no_markers": {
      const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      return `${existing}${sep}${wrapped}`;
    }
    default:
      throw new Error(
        "The BASOU:PROTOCOLS markers in the target are malformed (a marker is missing, duplicated, or out of order). Fix or remove them, then retry.",
      );
  }
}

/**
 * Back up the target's original content the first time basou modifies it.
 * Uses a single stable `<target>.basou-bak` and never overwrites it, so the
 * pre-basou original is preserved exactly once. No-op when a backup already
 * exists or the target does not exist.
 */
async function backupOnce(target: string, existing: string | null): Promise<void> {
  if (existing === null) return;
  const bak = `${target}.basou-bak`;
  const already = await readMarkdownFile(bak);
  if (already !== null) return;
  await writeFileDurable(bak, existing);
}

export async function doRunProtocolSync(options: ProtocolSyncOptions): Promise<void> {
  const configPath = options.config ?? DEFAULT_PROTOCOLS_CONFIG_PATH;
  const target = options.target ?? DEFAULT_TARGET_PATH;

  const entries = await loadProtocolsConfig(configPath);
  const sources = await readProtocolSources(entries);
  const block = buildBlock(sources);

  await assertNotSymlink(target);
  const existing = await readMarkdownFile(target);
  const newBody = buildTargetBody(existing, block);

  if (newBody === existing) {
    console.log(`The basou:protocols block is already up to date (${entries.length} protocol(s)).`);
    return;
  }

  // Install vs update wording comes from the parsed result, not a substring
  // check, so marker text appearing in the user's prose is not mistaken for an
  // installed block.
  const hadBlock = existing !== null && parseMarkers(existing, PROTOCOL_MARKERS).kind === "ok";

  if (options.dryRun === true) {
    console.log(
      `[dry-run] Would ${hadBlock ? "update" : "install"} the basou:protocols block (${entries.length} protocol(s)).`,
    );
    for (const { entry } of sources) {
      console.log(`  - ${entry.title ?? entry.source}`);
    }
    return;
  }

  // Optimistic concurrency: re-read and abort if the file changed since the
  // read above, so a concurrent edit is not clobbered. This narrows but does
  // not fully close the window (a writer landing between this read and the
  // rename inside writeFileDurable is still possible); hard exclusion would
  // need a lock, which is out of scope for this slice.
  const recheck = await readMarkdownFile(target);
  if (recheck !== existing) {
    throw new Error(
      "The target changed during sync; aborting so a concurrent edit is not overwritten. Re-run 'basou protocol sync'.",
    );
  }

  // Back up the original only after the CAS check passes, so an aborted run
  // never leaves a backup of a file it did not modify.
  await backupOnce(target, existing);
  await writeFileDurable(target, newBody);
  console.log(
    `${hadBlock ? "Updated" : "Installed"} the basou:protocols block in the global CLAUDE.md (${entries.length} protocol(s)).`,
  );
}

export async function doRunProtocolList(options: ProtocolCommonOptions): Promise<void> {
  const configPath = options.config ?? DEFAULT_PROTOCOLS_CONFIG_PATH;
  const target = options.target ?? DEFAULT_TARGET_PATH;

  const entries = await loadProtocolsConfig(configPath);
  const existing = await readMarkdownFile(target);
  const installed = existing !== null && parseMarkers(existing, PROTOCOL_MARKERS).kind === "ok";

  console.log(`Declared protocols (${entries.length}):`);
  for (const entry of entries) {
    console.log(`  - ${entry.title ?? entry.source}`);
  }
  console.log(installed ? "Block: installed in the global CLAUDE.md." : "Block: not installed.");
}

export async function doRunProtocolUnsync(options: ProtocolSyncOptions): Promise<void> {
  const target = options.target ?? DEFAULT_TARGET_PATH;

  await assertNotSymlink(target);
  const existing = await readMarkdownFile(target);
  if (existing === null) {
    console.log("No target file; nothing to remove.");
    return;
  }

  const newBody = removeMarkerSection(existing, "CLAUDE.md", PROTOCOL_MARKERS);
  if (newBody === existing) {
    console.log("No basou:protocols block found; nothing removed.");
    return;
  }

  if (options.dryRun === true) {
    console.log("[dry-run] Would remove the basou:protocols block from the global CLAUDE.md.");
    return;
  }

  // Optimistic concurrency (see sync): re-read and abort on a concurrent edit
  // before backing up or writing, so an aborted run leaves nothing behind.
  const recheck = await readMarkdownFile(target);
  if (recheck !== existing) {
    throw new Error(
      "The target changed during unsync; aborting so a concurrent edit is not overwritten. Re-run 'basou protocol unsync'.",
    );
  }

  await backupOnce(target, existing);
  await writeFileDurable(target, newBody);
  console.log("Removed the basou:protocols block from the global CLAUDE.md.");
}
