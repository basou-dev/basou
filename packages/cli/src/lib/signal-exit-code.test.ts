import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { signalToExitCode } from "./signal-exit-code.js";

describe("signalToExitCode", () => {
  it("gives 128 plus the POSIX number for the five signals whose number every platform shares", () => {
    expect(signalToExitCode("SIGHUP")).toBe(129);
    expect(signalToExitCode("SIGINT")).toBe(130);
    expect(signalToExitCode("SIGQUIT")).toBe(131);
    expect(signalToExitCode("SIGKILL")).toBe(137);
    expect(signalToExitCode("SIGTERM")).toBe(143);
  });

  it("gives 128 plus this platform's number for every other signal, not SIGHUP's 129", () => {
    // SIGUSR1 is 10 on Linux and 30 on macOS; the shell reports the local one.
    for (const sig of ["SIGUSR1", "SIGUSR2", "SIGSEGV", "SIGPIPE", "SIGABRT", "SIGALRM"] as const) {
      const num = constants.signals[sig];
      expect(num, sig).toBeGreaterThan(1);
      expect(signalToExitCode(sig), sig).toBe(128 + num);
    }
  });

  it("covers every signal this platform has", () => {
    for (const [name, num] of Object.entries(constants.signals)) {
      expect(signalToExitCode(name as NodeJS.Signals), name).toBe(128 + num);
    }
  });

  it("gives 1 when no signal ended the child", () => {
    expect(signalToExitCode(null)).toBe(1);
  });
});
