import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findErrorCode } from "../storage/status.js";
import { ChildProcessRunner } from "./child-process-runner.js";

const NODE = process.execPath;

const isWindows = process.platform === "win32";
const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
const skipPosixOnly = isWindows || isRoot;

describe("ChildProcessRunner", () => {
  let cwd: string;
  let runner: ChildProcessRunner;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "basou-cpr-"));
    runner = new ChildProcessRunner();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { force: true, recursive: true });
  });

  // 1
  it("captures stdout and exit_code=0 (happy path)", async () => {
    const result = await runner.run(NODE, ["-e", "process.stdout.write('hello')"], { cwd });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
  });

  // 2
  it("returns a non-zero exit_code without throwing", async () => {
    const result = await runner.run(NODE, ["-e", "process.exit(7)"], { cwd });
    expect(result.exit_code).toBe(7);
    expect(result.signal).toBeNull();
  });

  // 3
  it("captures stderr separately from stdout", async () => {
    const result = await runner.run(NODE, ["-e", "process.stderr.write('warn'); process.exit(0)"], {
      cwd,
    });
    expect(result.stderr).toBe("warn");
    expect(result.stdout).toBe("");
  });

  // 4
  it("passes stdin through to the child", async () => {
    const result = await runner.run(NODE, ["-e", "process.stdin.pipe(process.stdout)"], {
      cwd,
      stdin: "abc",
    });
    expect(result.stdout).toBe("abc");
  });

  // 5
  it("captures UTF-8 multibyte stdout", async () => {
    const result = await runner.run(NODE, ["-e", "process.stdout.write('こんにちは')"], { cwd });
    expect(result.stdout).toBe("こんにちは");
  });

  // 6
  it("rejects when the signal is already aborted before spawn", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancel"));
    await expect(
      runner.run(NODE, ["-e", "process.exit(0)"], {
        cwd,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Process aborted before spawn");
  });

  // 7 (POSIX only — Windows emulates signals and the close tuple may differ)
  it.skipIf(skipPosixOnly)(
    "kills the child via SIGTERM/SIGKILL when aborted mid-run",
    async () => {
      const controller = new AbortController();
      const promise = runner.run(NODE, ["-e", "setInterval(() => {}, 1000)"], {
        cwd,
        signal: controller.signal,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      controller.abort();
      const result = await promise;
      expect(result.exit_code).toBeNull();
      expect(result.signal).not.toBeNull();
    },
    10_000,
  );

  // 8 (POSIX only)
  it.skipIf(skipPosixOnly)(
    "kills the child after timeout_ms",
    async () => {
      const result = await runner.run(NODE, ["-e", "setInterval(() => {}, 1000)"], {
        cwd,
        timeout_ms: 100,
      });
      expect(result.exit_code).toBeNull();
      expect(result.signal).not.toBeNull();
    },
    10_000,
  );

  // 9
  it("throws 'Command not found' for ENOENT", async () => {
    await expect(runner.run("__nonexistent_cmd_xyzabc__", [], { cwd })).rejects.toThrow(
      "Command not found",
    );
  });

  // 10
  it("uses the cwd option as the child's working directory", async () => {
    const result = await runner.run(NODE, ["-e", "process.stdout.write(process.cwd())"], { cwd });
    expect(result.stdout).toContain(path.basename(cwd));
  });

  // 11
  it("overrides env when env option is set", async () => {
    const result = await runner.run(NODE, ["-e", "process.stdout.write(process.env.FOO ?? '')"], {
      cwd,
      env: { ...process.env, FOO: "bar" },
    });
    expect(result.stdout).toBe("bar");
  });

  // 12
  it("populates RunResult observation fields", async () => {
    const result = await runner.run(NODE, ["-e", "setTimeout(() => {}, 100)"], { cwd });
    expect(typeof result.pid).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(100);
    expect(result.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.command).toBe(NODE);
  });

  // 13
  it("does not interpret shell metacharacters in args (shell:false)", async () => {
    const result = await runner.run(
      NODE,
      ["-e", "process.stdout.write('a')", ";", "rm", "-rf", "/"],
      { cwd },
    );
    expect(result.stdout).toBe("a");
    expect(result.exit_code).toBe(0);
  });

  // 14 (POSIX only — chmod 0o000 has no effect under root)
  it.skipIf(skipPosixOnly)(
    "rejects with pathless message and EACCES cause when binary lacks execute permission",
    async () => {
      const scriptPath = path.join(cwd, "noexec.sh");
      await writeFile(scriptPath, "#!/bin/sh\necho hi\n");
      await chmod(scriptPath, 0o000);
      try {
        let caught: unknown;
        await runner.run(scriptPath, [], { cwd }).catch((err: unknown) => {
          caught = err;
        });
        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error;
        // Pathless: neither cwd nor the script path leak into the message.
        expect(err.message).not.toContain(cwd);
        expect(err.message).not.toContain(scriptPath);
        // Generic spawn-error message (not the ENOENT-specific one).
        expect(err.message).toBe("Failed to spawn child process");
        // The errno is preserved on the cause chain for callers to classify.
        expect(findErrorCode(err, "EACCES")).toBe(true);
      } finally {
        await chmod(scriptPath, 0o755);
      }
    },
  );

  // 15
  it("removes the abort listener after run completes", async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await runner.run(NODE, ["-e", "process.exit(0)"], {
      cwd,
      signal: controller.signal,
    });
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  // 16 (POSIX only) — Note: this case verifies that aborting immediately
  // after the run() Promise is created still kills the child. The
  // narrower spawn-vs-listener-attach window is synchronous in the
  // implementation and not externally observable, so the actual
  // post-attach race guard is exercised only indirectly here.
  it.skipIf(skipPosixOnly)(
    "kills the child when abort fires immediately after promise creation",
    async () => {
      const controller = new AbortController();
      const promise = runner.run(NODE, ["-e", "setInterval(() => {}, 1000)"], {
        cwd,
        signal: controller.signal,
      });
      controller.abort();
      const result = await promise;
      expect(result.exit_code).toBeNull();
      expect(result.signal).not.toBeNull();
    },
    10_000,
  );

  // 17 (parameterized)
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects invalid timeout_ms (%s)", async (_label, value) => {
    await expect(
      runner.run(NODE, ["-e", "process.exit(0)"], {
        cwd,
        timeout_ms: value,
      }),
    ).rejects.toThrow("Invalid timeout_ms");
  });

  // 18
  it("captures large stdout (>= 1MiB) without hanging", async () => {
    const oneMiB = 1024 * 1024;
    const result = await runner.run(NODE, ["-e", `process.stdout.write('x'.repeat(${oneMiB}))`], {
      cwd,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout.length).toBeGreaterThanOrEqual(oneMiB);
  }, 30_000);

  // 19 — Note: this case verifies that the timeout timer is cleared once
  // the child exits naturally, so no kill is attempted afterward. The
  // narrower kill-after-natural-exit race (timer fires while close is in
  // flight) is not deterministically reproducible from the public API and
  // is left to the in-source race guard `if (killed || child.exitCode
  // !== null) return;`.
  it("clears the kill timer once the child exits naturally", async () => {
    const result = await runner.run(NODE, ["-e", "process.exit(0)"], {
      cwd,
      timeout_ms: 50,
    });
    expect(result.exit_code).toBe(0);
    expect(result.signal).toBeNull();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  });
});
