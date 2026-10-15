import { constants } from "node:os";

/**
 * The five signals whose exit codes the compatibility promise makes exact.
 * Their numbers are the same on every POSIX platform, so they are fixed here
 * rather than read from the platform's table.
 */
const PROMISED_SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * For a signal name with no number on this platform. It is `128` plus no
 * signal's number (Linux's highest is 64, giving 192), so it cannot be read as
 * naming one.
 */
const UNNUMBERED_SIGNAL_EXIT_CODE = 255;

/**
 * The exit code for a child a signal ended, the way the platform's shell
 * reports it: `128` plus the signal's number. The five promised signals give
 * 129, 130, 131, 137 and 143 everywhere. Any other signal gives this
 * platform's number (`SIGUSR1` is `138` on Linux and `158` on macOS), so a
 * value is only comparable on one platform; the recorded signal name says
 * which signal it was. `null` (no signal) is a plain failure, `1`.
 *
 * A name with no number here gives {@link UNNUMBERED_SIGNAL_EXIT_CODE}; none is
 * expected, as Node names only the signals its platform table has. A signal
 * Node has no name for (`SIGEMT` on macOS, the real-time signals on Linux)
 * never reaches this function: Node reports that child as having exited with
 * code `0`.
 */
export function signalToExitCode(sig: NodeJS.Signals | null): number {
  if (sig === null) return 1;
  const num = PROMISED_SIGNAL_NUMBERS[sig] ?? constants.signals[sig];
  return num === undefined ? UNNUMBERED_SIGNAL_EXIT_CODE : 128 + num;
}
