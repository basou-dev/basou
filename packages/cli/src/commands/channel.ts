import type { Command } from "commander";
import { CODEX_TARGET_PATH, clearOrientationChannel } from "../lib/context-channel.js";
import { isVerbose, renderCliError } from "../lib/error-render.js";

/** The user-global context faces basou can render into. */
export type ChannelFace = "codex";

export type ChannelClearOptions = {
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
  /** Override the locked face path (intended for tests). */
  target?: string;
};

/**
 * Wire `basou channel` onto `program`. A context face is a file an AI coding
 * tool auto-loads at startup for EVERY project on the machine — `~/.codex/
 * AGENTS.md` for Codex — so a block one workspace rendered there sits in the
 * context of every other workspace's next session until it is overwritten or
 * removed. Rendering is opt-in per workspace (`channels.codex: true` in the
 * manifest, never when `confidential: true`); `clear` is the manual escape
 * hatch for a block that is already there.
 */
export function registerChannelCommand(program: Command): void {
  const channel = program
    .command("channel")
    .description(
      "Manage the user-global context faces basou renders into — files every project's AI tool auto-loads (~/.codex/AGENTS.md)",
    );

  channel
    .command("clear")
    .argument(
      "<face>",
      "the face to clear: `codex` (the basou:orientation block in ~/.codex/AGENTS.md)",
    )
    .description(
      "Remove basou's block from a user-global context face, so no workspace's position is left in a file that another project's tool reads",
    )
    .option("--dry-run", "Report whether a block would be removed without writing")
    .option("--json", "Output the result as JSON")
    .option("--target <path>", "Override the target file (intended for tests)")
    .option("-v, --verbose", "Show error causes")
    .action(async (face: string, opts: ChannelClearOptions) => {
      await runChannelClear(face, opts);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunChannelClear}. */
export async function runChannelClear(face: string, options: ChannelClearOptions): Promise<void> {
  if (face !== "codex") {
    // The Claude Code face carries the protocol block, which has its own verb;
    // point there rather than clearing something this command does not own.
    console.error(
      `Unknown face '${face}'. Faces: codex (~/.codex/AGENTS.md). The basou:protocols block in ~/.claude/CLAUDE.md is removed with \`basou protocol unsync\`.`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    await doRunChannelClear(face, options);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** Result of {@link doRunChannelClear}; also the `--json` shape. */
export type ChannelClearResult = {
  face: ChannelFace;
  /** The file acted on, as shown to the operator (the locked label unless overridden). */
  target: string;
  removed: boolean;
  dry_run: boolean;
};

export async function doRunChannelClear(
  face: ChannelFace,
  options: ChannelClearOptions,
): Promise<ChannelClearResult> {
  const isDry = options.dryRun === true;
  const { removed } = await clearOrientationChannel({
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(isDry ? { dryRun: true } : {}),
  });
  const target = options.target ?? CODEX_TARGET_PATH;
  const label = options.target ?? "~/.codex/AGENTS.md";
  const result: ChannelClearResult = { face, target, removed, dry_run: isDry };

  if (options.json === true) {
    console.log(JSON.stringify(result));
    return result;
  }
  if (!removed) {
    console.log(`Nothing to clear: ${label} carries no basou:orientation block.`);
  } else if (isDry) {
    console.log(`[dry-run] Would remove the basou:orientation block from ${label}.`);
  } else {
    console.log(
      `Removed the basou:orientation block from ${label}. Nothing basou wrote remains in that file; the next opted-in \`basou refresh\` renders it again.`,
    );
  }
  return result;
}
