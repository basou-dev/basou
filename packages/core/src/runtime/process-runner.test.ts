import { describe, expect, it } from "vitest";

import type { RunOptions, RunResult } from "./process-runner.js";

describe("ProcessRunner type contract", () => {
  it("RunOptions requires cwd; env/signal/timeout_ms/stdin are optional", () => {
    const minimal: RunOptions = { cwd: "/tmp" };
    expect(minimal.cwd).toBe("/tmp");

    const ac = new AbortController();
    const full: RunOptions = {
      cwd: "/tmp",
      env: { FOO: "bar" },
      signal: ac.signal,
      timeout_ms: 1000,
      stdin: "input",
    };
    expect(full.timeout_ms).toBe(1000);
    expect(full.env?.FOO).toBe("bar");
    expect(full.signal).toBe(ac.signal);
    expect(full.stdin).toBe("input");
  });

  it("RunResult observation snapshot covers normal exit and signal kill", () => {
    const now = "2026-05-06T00:00:00.000Z";

    const normalExit: RunResult = {
      command: "x",
      args: [],
      cwd: "/tmp",
      exit_code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      started_at: now,
      ended_at: now,
      duration_ms: 0,
      pid: 1,
    };
    expect(normalExit.exit_code).toBe(0);
    expect(normalExit.signal).toBeNull();

    const killedBySignal: RunResult = {
      command: "x",
      args: [],
      cwd: "/tmp",
      exit_code: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      started_at: now,
      ended_at: now,
      duration_ms: 0,
      pid: null,
    };
    expect(killedBySignal.exit_code).toBeNull();
    expect(killedBySignal.signal).toBe("SIGTERM");
  });
});
