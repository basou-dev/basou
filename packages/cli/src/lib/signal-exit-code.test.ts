import { constants } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signalToExitCode } from "./signal-exit-code.js";

// What each platform's shell reports for a child the signal ended (`$?`),
// written out rather than computed, so the test does not repeat the code.
const SAME_ON_LINUX_AND_MACOS: Record<string, number> = {
  SIGILL: 132,
  SIGTRAP: 133,
  SIGABRT: 134,
  SIGFPE: 136,
  SIGSEGV: 139,
  SIGPIPE: 141,
  SIGALRM: 142,
};
const BY_PLATFORM: Record<string, { linux: number; darwin: number }> = {
  SIGBUS: { linux: 135, darwin: 138 },
  SIGUSR1: { linux: 138, darwin: 158 },
  SIGUSR2: { linux: 140, darwin: 159 },
  SIGSYS: { linux: 159, darwin: 140 },
};

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
});

describe("signalToExitCode", () => {
  it("gives the promised values for SIGHUP, SIGINT, SIGQUIT, SIGKILL and SIGTERM", () => {
    expect(signalToExitCode("SIGHUP")).toBe(129);
    expect(signalToExitCode("SIGINT")).toBe(130);
    expect(signalToExitCode("SIGQUIT")).toBe(131);
    expect(signalToExitCode("SIGKILL")).toBe(137);
    expect(signalToExitCode("SIGTERM")).toBe(143);
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "gives what this platform's shell reports for every other signal, not SIGHUP's 129",
    () => {
      const platform = process.platform as "linux" | "darwin";
      for (const [sig, code] of Object.entries(SAME_ON_LINUX_AND_MACOS)) {
        expect(signalToExitCode(sig as NodeJS.Signals), sig).toBe(code);
      }
      for (const [sig, codes] of Object.entries(BY_PLATFORM)) {
        expect(signalToExitCode(sig as NodeJS.Signals), sig).toBe(codes[platform]);
      }
    },
  );

  it("gives 255, which is 128 plus no signal's number, for a name with no number", () => {
    const code = signalToExitCode("SIGNOTREAL" as NodeJS.Signals);
    expect(code).toBe(255);
    expect(Object.values(constants.signals).map((n) => 128 + n)).not.toContain(code);
  });

  it("keeps the promised values without the platform's table, and gives 255 for the rest", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return { ...actual, constants: { ...actual.constants, signals: {} } };
    });
    const { signalToExitCode: withEmptyTable } = await import("./signal-exit-code.js");
    expect(
      (["SIGHUP", "SIGINT", "SIGQUIT", "SIGKILL", "SIGTERM"] as const).map(withEmptyTable),
    ).toEqual([129, 130, 131, 137, 143]);
    expect(withEmptyTable("SIGSEGV")).toBe(255);
  });

  it("gives 1 when no signal ended the child", () => {
    expect(signalToExitCode(null)).toBe(1);
  });
});
