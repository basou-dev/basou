import { readFile, stat } from "node:fs/promises";
import {
  carryForwardProtocolStamp,
  PROTOCOL_END,
  PROTOCOL_START,
  type ProtocolStamp,
  parseMarkers,
  parseProtocolStamp,
  protocolBlockHash,
  readMarkdownFile,
  renderProtocolStamp,
  unstampedProtocolSectionsFrom,
} from "@basou/core";
import type { Command } from "commander";
import { assertNoMarkerLine, removeMarkerBlock, syncMarkerBlock } from "../lib/context-channel.js";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import {
  findForeignWorkspaceNames,
  protocolForeignWorkspaceWarning,
} from "../lib/foreign-workspace-warn.js";
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

/** Injection seam for `protocol sync` (tests only; the command passes nothing). */
export type ProtocolSyncContext = {
  /** Override path to the portfolio registry (`~/.basou/portfolio.yaml`). */
  portfolioConfigPath?: string;
};

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
    .description(
      "Render declared protocols into ~/.claude/CLAUDE.md (creates/updates the block). That file is user-global: " +
        "Claude Code auto-loads it for every project on the machine, so what the protocols say is in the context of " +
        "every workspace's sessions — keep workspace-specific facts out of them.",
    )
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
    assertNoMarkerLine(content, PROTOCOL_MARKERS);
    out.push({ entry, content });
  }
  return out;
}

/**
 * The rendered protocol text: the declared sources, in order, each under its
 * title. This is the ONLY thing the stamp hashes and the only thing a delivery
 * carries, so the digest describes exactly the bytes a session reads.
 */
function buildSections(sources: { entry: ProtocolEntry; content: string }[]): string {
  return sources
    .map(({ entry, content }) => {
      const body = content.replace(/\s+$/, "");
      return entry.title !== undefined ? `## ${entry.title}\n\n${body}` : body;
    })
    .join("\n\n");
}

/**
 * Assemble the inner block body (without the markers): the managed note, the
 * sync stamp, then the rendered protocol text.
 *
 * The stamp records when that text last changed. A session reads this block at
 * start; a Stop hook later compares the stamp against when the session started
 * to tell whether the protocols moved underneath it (see `protocol-stamp` in
 * core). A carried-forward timestamp means a sync that changes nothing renders
 * the same bytes, so the channel still reports "unchanged".
 */
function buildBlock(sections: string, stamp: ProtocolStamp): string {
  return `${MANAGED_NOTE}\n${renderProtocolStamp(stamp)}\n\n${sections}\n`;
}

/**
 * What the block currently in `target` says about itself, or `null` when there
 * is no readable block to say anything.
 *
 * A block written by a basou older than the stamp carries none, and taking
 * that as "nothing is known" would date the new stamp at the current time —
 * announcing a change to every session running the first time the new basou
 * syncs, when in fact the text they hold is the text they are about to be
 * handed. So an unstamped block is read for its protocol text and reported as
 * a stamp dated at the file's last write, which is the best evidence of when
 * that text was put there. Carry-forward then keeps that date if the text is
 * unchanged, and the upgrade is silent.
 */
async function readPreviousStamp(target: string): Promise<ProtocolStamp | null> {
  const existing = await readMarkdownFile(target);
  if (existing === null) return null;
  const section = parseMarkers(existing, PROTOCOL_MARKERS);
  if (section.kind !== "ok") return null;
  const stamp = parseProtocolStamp(section.generated);
  if (stamp !== null) return stamp;
  const writtenAt = await lastWrittenAt(target);
  if (writtenAt === null) return null;
  return {
    changedAt: writtenAt,
    contentHash: protocolBlockHash(unstampedProtocolSectionsFrom(section.generated)),
  };
}

/** The target's last-write time as an ISO string, or `null` when unreadable. */
async function lastWrittenAt(target: string): Promise<string | null> {
  try {
    return new Date((await stat(target)).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

export async function doRunProtocolSync(
  options: ProtocolSyncOptions,
  ctx: ProtocolSyncContext = {},
): Promise<void> {
  const configPath = options.config ?? DEFAULT_PROTOCOLS_CONFIG_PATH;
  const target = options.target ?? DEFAULT_TARGET_PATH;

  const entries = await loadProtocolsConfig(configPath);
  const sources = await readProtocolSources(entries);
  const sections = buildSections(sources);
  const stamp = carryForwardProtocolStamp({
    sections,
    previous: await readPreviousStamp(target),
    now: new Date().toISOString(),
  });
  const block = buildBlock(sections, stamp);

  // Content check (advisory): this block is the one thing basou still renders
  // into a USER-GLOBAL file, and it reads no manifest, so nothing else in the
  // pipeline would notice a standing protocol that names one workspace. The
  // block is written either way — a standing protocol naming a workspace can be
  // exactly what the operator meant — but the warning is printed only once the
  // sync has actually gone through, so a run that failed and wrote nothing does
  // not claim the name reached the file. Under `--dry-run` it still prints:
  // previewing is when the operator wants to hear it.
  const foreign = await findForeignWorkspaceNames({
    text: block,
    configPath: ctx.portfolioConfigPath,
  });

  // The shared channel helper owns the symlink guard, append/replace, backup,
  // and optimistic-concurrency recheck; the install-vs-update verb it returns
  // comes from a parsed marker check, so marker text in the user's prose is not
  // mistaken for an installed block.
  const result = await syncMarkerBlock({
    target,
    markers: PROTOCOL_MARKERS,
    block,
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });

  if (foreign !== null) console.error(protocolForeignWorkspaceWarning(foreign));

  if (result.action === "unchanged") {
    console.log(`The basou:protocols block is already up to date (${entries.length} protocol(s)).`);
    return;
  }

  if (options.dryRun === true) {
    console.log(
      `[dry-run] Would ${result.action === "updated" ? "update" : "install"} the basou:protocols block (${entries.length} protocol(s)).`,
    );
    for (const { entry } of sources) {
      console.log(`  - ${entry.title ?? entry.source}`);
    }
    return;
  }

  console.log(
    `${result.action === "updated" ? "Updated" : "Installed"} the basou:protocols block in the global CLAUDE.md (${entries.length} protocol(s)).`,
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

  const result = await removeMarkerBlock({
    target,
    markers: PROTOCOL_MARKERS,
    fileLabel: "CLAUDE.md",
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });

  if (!result.removed) {
    console.log("No basou:protocols block found; nothing removed.");
    return;
  }
  if (options.dryRun === true) {
    console.log("[dry-run] Would remove the basou:protocols block from the global CLAUDE.md.");
    return;
  }
  console.log("Removed the basou:protocols block from the global CLAUDE.md.");
}
