import { type CommandLookup, isOnPath } from "../command-lookup.js";

export type { CommandLookup };

/**
 * Static metadata identifying the claude-code adapter as the session source.
 * Consumed by the CLI orchestration when populating `session.yaml.source`
 * and event `source` fields. The literal `kind` is part of the wire format
 * defined by the session schema; do not change without coordinated schema
 * migration.
 */
export const claudeCodeAdapterMetadata = {
  kind: "claude-code-adapter",
  version: "0.1.0",
} as const;

/**
 * Resolve the Claude Code CLI executable name. Tries `claude-code` first
 * and falls back to `claude`; the first candidate found on PATH wins.
 *
 * Throws a fixed-message Error when neither candidate is reachable, so
 * callers can present a single user-facing prompt to install the CLI.
 *
 * @throws Error("Claude Code CLI not found in PATH. Install claude-code (or claude) first.")
 */
export async function resolveClaudeCodeCommand(
  lookup: CommandLookup = isOnPath,
): Promise<{ command: string }> {
  for (const candidate of ["claude-code", "claude"]) {
    if (await lookup(candidate)) return { command: candidate };
  }
  throw new Error("Claude Code CLI not found in PATH. Install claude-code (or claude) first.");
}

/**
 * Stub for the future `adapter_output` summary generator.
 *
 * The current release keeps `capture: "none"` and intentionally does
 * not emit `adapter_output` events, so this hook has no production
 * callers yet. The signature is committed so a later release can
 * implement raw_ref generation without retrofitting the adapter
 * scaffold.
 *
 * @throws Error - always; not implemented in this release.
 */
export function summarizeAdapterOutput(_stream: "stdout" | "stderr", _raw: string): string {
  throw new Error("adapter_output summary is not implemented in this release");
}
