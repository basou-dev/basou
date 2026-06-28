import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunHookInstall,
  doRunHookStatus,
  doRunHookStop,
  doRunHookUninstall,
  type HookInstallContext,
  type HookStopContext,
  parseMinEdits,
  readTranscriptBounded,
  runHookInstall,
} from "./hook.js";

/** A transcript line for one assistant message carrying N read-only Bash commands. */
function bashLine(n: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-24T00:00:00.000Z",
    message: {
      content: Array.from({ length: n }, (_, i) => ({
        type: "tool_use",
        name: "Bash",
        input: { command: `echo ${i}` },
      })),
    },
  });
}

/** A transcript line for one assistant message carrying N file edits. */
function editLine(n: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-24T00:00:00.000Z",
    message: {
      content: Array.from({ length: n }, (_, i) => ({
        type: "tool_use",
        name: "Edit",
        input: { file_path: `/x/f${i}.ts` },
      })),
    },
  });
}

/** Drive doRunHookStop with injected stdin + transcript, returning what it wrote. */
async function run(
  stdin: unknown,
  transcript: string | { error: true },
  opts: { minEdits?: number; block?: boolean } = {},
): Promise<string> {
  let out = "";
  const ctx: HookStopContext = {
    readStdin: async () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    readTranscript: async () => {
      if (typeof transcript !== "string") throw new Error("unreadable");
      return transcript;
    },
    write: (text) => {
      out += text;
    },
  };
  await doRunHookStop(opts, ctx);
  return out;
}

function nudgeContext(out: string): string {
  expect(out.length).toBeGreaterThan(0);
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  return parsed.hookSpecificOutput.additionalContext;
}

describe("doRunHookStop", () => {
  it("emits a Stop additionalContext nudge for a substantive, uncaptured session", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [editLine(2)].join("\n"),
    );
    const context = nudgeContext(out);
    expect(context).toContain("basou decision capture");
    expect(context).toContain("basou note");
  });

  it("stays silent for a read-only Bash session (no edits / no strong signal)", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [bashLine(8)].join("\n"),
    );
    expect(out).toBe("");
  });

  it("stays silent when the session already captured", async () => {
    const transcript = [
      editLine(3),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "basou note x" } }],
        },
      }),
    ].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript);
    expect(out).toBe("");
  });

  it("stays silent when stop_hook_active is true (loop guard)", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: true },
      [editLine(5)].join("\n"),
    );
    expect(out).toBe("");
  });

  it("stays silent for a single trivial edit (below the edit threshold)", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [editLine(1)].join("\n"),
    );
    expect(out).toBe("");
  });

  it("respects a custom --min-edits threshold", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [editLine(1)].join("\n"),
      { minEdits: 1 },
    );
    expect(nudgeContext(out)).toContain("basou decision capture");
  });

  it("skips blank and malformed transcript lines without failing", async () => {
    const transcript = ["", "not json", editLine(2), "  ", "{bad"].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript);
    expect(nudgeContext(out)).toContain("basou decision capture");
  });

  it("fails open on empty stdin", async () => {
    const out = await run("", [editLine(2)].join("\n"));
    expect(out).toBe("");
  });

  it("fails open on malformed stdin JSON", async () => {
    const out = await run("{not json", [editLine(2)].join("\n"));
    expect(out).toBe("");
  });

  it("fails open when transcript_path is missing", async () => {
    const out = await run({ stop_hook_active: false }, [editLine(2)].join("\n"));
    expect(out).toBe("");
  });

  it("fails open when the transcript cannot be read", async () => {
    const out = await run(
      { transcript_path: "/missing.jsonl", stop_hook_active: false },
      { error: true },
    );
    expect(out).toBe("");
  });

  it("treats a missing stop_hook_active as not-active", async () => {
    const out = await run({ transcript_path: "/t.jsonl" }, [editLine(2)].join("\n"));
    expect(nudgeContext(out)).toContain("basou decision capture");
  });
});

describe("doRunHookStop --block (opt-in enforcement)", () => {
  it("emits a decision:block with the same reason text for a substantive session", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [editLine(2)].join("\n"),
      { block: true },
    );
    const parsed = JSON.parse(out) as { decision: string; reason: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("basou decision capture");
    // The blocking envelope carries no advisory hookSpecificOutput.
    expect(out).not.toContain("hookSpecificOutput");
  });

  it("still honors the loop guard (silent when stop_hook_active)", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: true },
      [editLine(5)].join("\n"),
      { block: true },
    );
    expect(out).toBe("");
  });

  it("stays silent for a non-substantive session even with --block", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [bashLine(8)].join("\n"),
      { block: true },
    );
    expect(out).toBe("");
  });
});

describe("hook install / uninstall / status", () => {
  let dir: string;
  let settingsPath: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const cliEntry = "/abs/basou/packages/cli/dist/index.js";
  const ctx: HookInstallContext = { resolveCliEntry: () => cliEntry };
  const advisoryCmd = `node '${cliEntry}' hook stop 2>/dev/null || true`;
  const blockingCmd = `node '${cliEntry}' hook stop --block 2>/dev/null || true`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-hook-install-"));
    settingsPath = join(dir, "settings.json");
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
  });
  afterEach(async () => {
    logSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  }

  it("installs the advisory hook into a non-existent settings.json", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const settings = (await readSettings()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(advisoryCmd);
    expect(settings.hooks.Stop[0]?.hooks[0]?.timeout).toBe(20);
    expect(logs.join("\n")).toContain("Installed");
  });

  it("preserves existing settings keys and a foreign SessionStart hook", async () => {
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          model: "opus",
          hooks: {
            SessionStart: [
              { matcher: "*", hooks: [{ type: "command", command: "node x orient" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const settings = (await readSettings()) as {
      model: string;
      hooks: { SessionStart: unknown[]; Stop: unknown[] };
    };
    expect(settings.model).toBe("opus");
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("is idempotent: re-installing the same mode reports no change", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    logs.length = 0;
    await doRunHookInstall({ settings: settingsPath }, ctx);
    expect(logs.join("\n")).toContain("already registered");
  });

  it("upgrades advisory -> blocking in place and writes a one-time backup", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    await doRunHookInstall({ settings: settingsPath, block: true }, ctx);
    const settings = (await readSettings()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(blockingCmd);
    // The backup preserves the pre-blocking (advisory) file.
    const backup = await readFile(`${settingsPath}.basou-bak`, "utf8");
    expect(backup).toContain(advisoryCmd);
  });

  it("status reports advisory, then blocking, then not-registered", async () => {
    await doRunHookStatus({ settings: settingsPath });
    expect(logs.join("\n")).toContain("not registered");

    logs.length = 0;
    await doRunHookInstall({ settings: settingsPath }, ctx);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    expect(logs.join("\n")).toMatch(/registered.*advisory/);

    logs.length = 0;
    await doRunHookInstall({ settings: settingsPath, block: true }, ctx);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    expect(logs.join("\n")).toMatch(/registered.*blocking/);
  });

  it("uninstall removes the basou hook and prunes empty scaffold", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    await doRunHookUninstall({ settings: settingsPath });
    expect(await readSettings()).toEqual({});
    expect(logs.join("\n")).toContain("Removed");
  });

  it("uninstall is a no-op when no basou hook is present", async () => {
    await writeFile(settingsPath, `${JSON.stringify({ model: "opus" }, null, 2)}\n`);
    await doRunHookUninstall({ settings: settingsPath });
    expect((await readSettings()).model).toBe("opus");
    expect(logs.join("\n")).toContain("nothing removed");
  });

  it("dry-run install does not write the file", async () => {
    await doRunHookInstall({ settings: settingsPath, dryRun: true }, ctx);
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
    expect(logs.join("\n")).toContain("[dry-run]");
  });
});

describe("parseMinEdits (lenient, fail-open)", () => {
  it("parses a valid non-negative integer", () => {
    expect(parseMinEdits("0")).toBe(0);
    expect(parseMinEdits("3")).toBe(3);
  });

  it("returns undefined (fall back to default) for invalid values, never throwing", () => {
    for (const bad of [undefined, "", "nope", "-1", "2.5", "1e3", " ", "NaN"]) {
      expect(parseMinEdits(bad)).toBeUndefined();
    }
  });
});

describe("readTranscriptBounded", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-hook-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the whole file when it is under the cap", async () => {
    const path = join(dir, "small.jsonl");
    const content = ["L0", "L1", "L2"].join("\n");
    await writeFile(path, content);
    expect(await readTranscriptBounded(path, 1024)).toBe(content);
  });

  it("reads only the trailing window and drops the first partial line when over the cap", async () => {
    const path = join(dir, "big.jsonl");
    // Each line is 11 bytes incl. newline; write 100 lines (~1100 bytes).
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
    await writeFile(path, `${lines.join("\n")}\n`);
    const tail = await readTranscriptBounded(path, 50);
    // The window is the last ~50 bytes; its first (partial) line is dropped, so
    // every returned line is a complete one and they are the final lines.
    expect(tail.length).toBeLessThanOrEqual(50);
    expect(tail).toContain("line-0099");
    expect(tail).not.toContain("line-0000");
    for (const line of tail.split("\n").filter((l) => l.length > 0)) {
      expect(line).toMatch(/^line-\d{4}$/);
    }
  });
});

describe("hook install/uninstall edge cases", () => {
  let dir: string;
  let settingsPath: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const cliEntry = "/abs/basou/packages/cli/dist/index.js";
  const ctx: HookInstallContext = { resolveCliEntry: () => cliEntry };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-hook-edge-"));
    settingsPath = join(dir, "settings.json");
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });
  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it("runHookInstall reports an error and exits non-zero on invalid settings JSON", async () => {
    await writeFile(settingsPath, "{ not valid json");
    await runHookInstall({ settings: settingsPath }, ctx);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("runHookInstall rejects an invalid --min-edits", async () => {
    await runHookInstall({ settings: settingsPath, minEdits: "nope" }, ctx);
    expect(process.exitCode).toBe(1);
    // Nothing was written because validation failed before any I/O.
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("registers a custom --min-edits in the command", async () => {
    await runHookInstall({ settings: settingsPath, minEdits: "5" }, ctx);
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(
      `node '${cliEntry}' hook stop --min-edits 5 2>/dev/null || true`,
    );
  });

  it("dry-run uninstall does not write", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const before = await readFile(settingsPath, "utf8");
    await doRunHookUninstall({ settings: settingsPath, dryRun: true });
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    expect(logs.join("\n")).toContain("[dry-run]");
  });
});
