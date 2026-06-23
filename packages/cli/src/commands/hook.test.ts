import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  doRunHookStop,
  type HookStopContext,
  parseMinActions,
  readTranscriptBounded,
} from "./hook.js";

/** A transcript line for one assistant message carrying N Bash commands. */
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

/** Drive doRunHookStop with injected stdin + transcript, returning what it wrote. */
async function run(
  stdin: unknown,
  transcript: string | { error: true },
  opts: { minActions?: number } = {},
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
      [bashLine(6)].join("\n"),
    );
    const context = nudgeContext(out);
    expect(context).toContain("basou decision capture");
    expect(context).toContain("basou note");
  });

  it("stays silent when the session already captured", async () => {
    const transcript = [
      bashLine(6),
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
      [bashLine(8)].join("\n"),
    );
    expect(out).toBe("");
  });

  it("stays silent for a trivial (below-threshold) session", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [bashLine(2)].join("\n"),
    );
    expect(out).toBe("");
  });

  it("respects a custom --min-actions threshold", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [bashLine(2)].join("\n"),
      { minActions: 2 },
    );
    expect(nudgeContext(out)).toContain("basou decision capture");
  });

  it("skips blank and malformed transcript lines without failing", async () => {
    const transcript = ["", "not json", bashLine(6), "  ", "{bad"].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript);
    expect(nudgeContext(out)).toContain("basou decision capture");
  });

  it("fails open on empty stdin", async () => {
    const out = await run("", [bashLine(6)].join("\n"));
    expect(out).toBe("");
  });

  it("fails open on malformed stdin JSON", async () => {
    const out = await run("{not json", [bashLine(6)].join("\n"));
    expect(out).toBe("");
  });

  it("fails open when transcript_path is missing", async () => {
    const out = await run({ stop_hook_active: false }, [bashLine(6)].join("\n"));
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
    const out = await run({ transcript_path: "/t.jsonl" }, [bashLine(6)].join("\n"));
    expect(nudgeContext(out)).toContain("basou decision capture");
  });
});

describe("parseMinActions (lenient, fail-open)", () => {
  it("parses a valid non-negative integer", () => {
    expect(parseMinActions("0")).toBe(0);
    expect(parseMinActions("3")).toBe(3);
  });

  it("returns undefined (fall back to default) for invalid values, never throwing", () => {
    for (const bad of [undefined, "", "nope", "-1", "2.5", "1e3", " ", "NaN"]) {
      expect(parseMinActions(bad)).toBeUndefined();
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
