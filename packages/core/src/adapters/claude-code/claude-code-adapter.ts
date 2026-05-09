import { spawn } from "node:child_process";

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
 * Lookup predicate used by {@link resolveClaudeCodeCommand} to decide
 * whether a candidate executable is reachable on PATH. Exposed as a
 * parameter so tests can substitute a deterministic mock; production
 * callers should omit it and rely on the default `which`-based lookup.
 */
export type CommandLookup = (command: string) => Promise<boolean>;

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
 * Default {@link CommandLookup} backed by `which` (POSIX) — the spawn
 * succeeds with exit code 0 iff the candidate is on PATH. Windows fallback
 * is intentionally not implemented in v0.1; call sites that target Windows
 * supply their own lookup.
 */
async function isOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [command], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Stub for the future `adapter_output` summary generator.
 *
 * v0.1 Step 11 keeps `capture: "none"` and intentionally does not emit
 * `adapter_output` events, so this hook has no production callers yet.
 * The signature is committed so that Step 12+ can implement raw_ref
 * generation without retrofitting the adapter scaffold.
 *
 * @throws Error - always; not implemented in v0.1 Step 11.
 */
export function summarizeAdapterOutput(_stream: "stdout" | "stderr", _raw: string): string {
  throw new Error("adapter_output summary is not implemented in v0.1 Step 11");
}
