import { type CommandLookup, isOnPath } from "../command-lookup.js";

/** Alias kept for API symmetry with the claude-code adapter's `CommandLookup`. */
export type CodexCommandLookup = CommandLookup;

/**
 * Static metadata identifying a live `basou run codex` session source. The twin
 * of {@link import("../claude-code/claude-code-adapter.js").claudeCodeAdapterMetadata};
 * `kind` is part of the wire format defined by the session schema
 * (`SessionSourceKindSchema`), so do not change it without a coordinated schema
 * migration. Distinct from `codex-import` (the after-the-fact rollout importer).
 */
export const codexAdapterMetadata = {
  kind: "codex-adapter",
  version: "0.1.0",
} as const;

/**
 * Resolve the Codex CLI executable name. Only `codex` is a candidate (unlike
 * claude-code's `claude-code`/`claude` pair, Codex ships a single binary name).
 *
 * Throws a fixed-message Error when it is not reachable, so callers can present
 * a single user-facing prompt to install the CLI.
 *
 * @throws Error("Codex CLI not found in PATH. Install codex first.")
 */
export async function resolveCodexCommand(
  lookup: CommandLookup = isOnPath,
): Promise<{ command: string }> {
  if (await lookup("codex")) return { command: "codex" };
  throw new Error("Codex CLI not found in PATH. Install codex first.");
}
