import type { Command } from "commander";

/**
 * The top-level commands that are outside every guarantee of
 * docs/spec/compatibility.md ("What is *not* guaranteed").
 *
 * This list and that document's table are the contract; the `[experimental]`
 * mark in `--help` is derived from this list and is not. A test pins the
 * three to each other, so a row added to the table alone, a name added here
 * alone, or a mark typed into a description or a summary by hand all fail it.
 *
 * A command joins only in the release that introduces it. An existing command
 * never joins, and leaving the list is a one-way promotion.
 */
export const EXPERIMENTAL_COMMANDS: readonly string[] = [];

export const EXPERIMENTAL_MARK = "[experimental]";

/**
 * Prefix the description of each listed top-level command, and of every
 * command under it, with the mark. The subcommands are marked too because the
 * whole subtree is experimental and `basou <command> <sub> --help` shows only
 * the subcommand's own description. A summary is marked as well, because a
 * parent's help lists a subcommand by its summary when it has one.
 */
export function markExperimentalCommands(
  program: Command,
  names: readonly string[] = EXPERIMENTAL_COMMANDS,
): void {
  for (const command of program.commands) {
    if (names.includes(command.name())) markSubtree(command);
  }
}

function markSubtree(command: Command): void {
  command.description(`${EXPERIMENTAL_MARK} ${command.description()}`);
  const summary = command.summary();
  if (summary !== "") command.summary(`${EXPERIMENTAL_MARK} ${summary}`);
  for (const sub of command.commands) markSubtree(sub);
}
