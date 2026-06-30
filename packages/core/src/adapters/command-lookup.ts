import { spawn } from "node:child_process";

/**
 * Predicate deciding whether a candidate executable is reachable on PATH.
 * Exposed as a parameter on the per-tool `resolve*Command` helpers so tests can
 * substitute a deterministic mock; production callers rely on {@link isOnPath}.
 */
export type CommandLookup = (command: string) => Promise<boolean>;

/**
 * Default {@link CommandLookup} backed by `which` (POSIX) — the spawn succeeds
 * with exit code 0 iff the candidate is on PATH. Shared by the claude-code and
 * codex adapters. Windows fallback is intentionally not implemented; call sites
 * that target Windows supply their own lookup.
 */
export async function isOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [command], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
