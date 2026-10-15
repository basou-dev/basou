import { constants } from "node:os";

/**
 * The exit code for a child a signal ended, the way a shell reports it: `128`
 * plus the signal's number on this platform (`SIGUSR1` is `10` on Linux and
 * `30` on macOS, as the shell's own `$?` would say). `null` (no signal) is a
 * plain failure, `1`.
 *
 * A child can only be ended by a signal its platform has, so every name Node
 * reports has a number here. A name without one (none is expected) still gives
 * a value above `128`, as the compatibility promise requires of a signal it
 * does not identify.
 */
export function signalToExitCode(sig: NodeJS.Signals | null): number {
  if (sig === null) return 1;
  return 128 + (constants.signals[sig] ?? 1);
}
