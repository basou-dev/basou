import { describe, expect, it } from "vitest";
import { DEFAULT_STOP_HOOK_MIN_ACTIONS, evaluateStopHook } from "./stop-hook.js";
import type { ClaudeTranscriptRecord } from "./transcript-importer.js";

/** Build an assistant record carrying the given tool_use items. */
function assistant(tools: Array<Record<string, unknown>>): ClaudeTranscriptRecord {
  return {
    type: "assistant",
    timestamp: "2026-06-24T00:00:00.000Z",
    message: { content: tools.map((t) => ({ type: "tool_use", ...t })) },
  };
}

/** N distinct Bash commands as one assistant record. */
function bashes(n: number): ClaudeTranscriptRecord {
  return assistant(
    Array.from({ length: n }, (_, i) => ({ name: "Bash", input: { command: `echo ${i}` } })),
  );
}

describe("evaluateStopHook", () => {
  it("nudges when a substantive session recorded no decisions or next step", () => {
    const result = evaluateStopHook({ records: [bashes(6)], stopHookActive: false });
    expect(result.kind).toBe("nudge");
    if (result.kind !== "nudge") throw new Error("expected nudge");
    expect(result.commandCount).toBe(6);
    expect(result.fileCount).toBe(0);
    expect(result.additionalContext).toContain("basou decision capture");
    expect(result.additionalContext).toContain("basou note");
    // It must give the model an out so it does not fabricate decisions.
    expect(result.additionalContext).toContain("just stop");
  });

  it("counts Bash commands and file edits together against the threshold", () => {
    const records = [
      assistant([
        { name: "Bash", input: { command: "ls" } },
        { name: "Edit", input: { file_path: "/x/a.ts" } },
        { name: "Write", input: { file_path: "/x/b.ts" } },
        { name: "NotebookEdit", input: { notebook_path: "/x/c.ipynb" } },
      ]),
      assistant([{ name: "Bash", input: { command: "pwd" } }]),
    ];
    const result = evaluateStopHook({ records, stopHookActive: false });
    expect(result.kind).toBe("nudge");
    if (result.kind !== "nudge") throw new Error("expected nudge");
    expect(result.commandCount).toBe(2);
    expect(result.fileCount).toBe(3);
  });

  it("stays silent for a trivial session below the action threshold", () => {
    const result = evaluateStopHook({ records: [bashes(2)], stopHookActive: false });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("not_substantive");
  });

  it("uses DEFAULT_STOP_HOOK_MIN_ACTIONS as the default boundary (inclusive)", () => {
    const below = evaluateStopHook({
      records: [bashes(DEFAULT_STOP_HOOK_MIN_ACTIONS - 1)],
      stopHookActive: false,
    });
    expect(below.kind).toBe("silent");
    const at = evaluateStopHook({
      records: [bashes(DEFAULT_STOP_HOOK_MIN_ACTIONS)],
      stopHookActive: false,
    });
    expect(at.kind).toBe("nudge");
  });

  it("honors a custom minActions threshold", () => {
    const result = evaluateStopHook({ records: [bashes(2)], stopHookActive: false, minActions: 2 });
    expect(result.kind).toBe("nudge");
  });

  it("stays silent once a capture verb ran this session (at a segment boundary)", () => {
    for (const command of [
      "basou decision capture <<'JSON'\n[]\nJSON",
      "basou decision record --title x",
      'basou note "next step"',
      'cd /repo && basou note "from a chained command"',
      'echo prep; basou note "after a semicolon"',
      "false || basou decision capture --file d.json",
    ]) {
      const records = [bashes(6), assistant([{ name: "Bash", input: { command } }])];
      const result = evaluateStopHook({ records, stopHookActive: false });
      expect(result.kind, command).toBe("silent");
      if (result.kind !== "silent") throw new Error("expected silent");
      expect(result.reason).toBe("already_captured");
    }
  });

  it("does not treat an unrelated basou command as a capture", () => {
    const records = [bashes(5), assistant([{ name: "Bash", input: { command: "basou orient" } }])];
    const result = evaluateStopHook({ records, stopHookActive: false });
    expect(result.kind).toBe("nudge");
  });

  it("does not treat a capture verb merely MENTIONED in another command as a capture", () => {
    // A capture verb inside a quoted argument (grep/echo) must not permanently
    // silence the nudge — it only counts when it starts a command segment.
    for (const command of [
      'rg "basou note" packages/',
      'echo "run basou decision capture later"',
      "git commit -m 'mention basou note in the message'",
    ]) {
      const records = [bashes(5), assistant([{ name: "Bash", input: { command } }])];
      const result = evaluateStopHook({ records, stopHookActive: false });
      expect(result.kind, command).toBe("nudge");
    }
  });

  it("stays silent (loop guard) when stop_hook_active is true, even if substantive + uncaptured", () => {
    const result = evaluateStopHook({ records: [bashes(10)], stopHookActive: true });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("stop_hook_active");
  });

  it("loop guard takes precedence over the already-captured reason", () => {
    const records = [bashes(6), assistant([{ name: "Bash", input: { command: "basou note x" } }])];
    const result = evaluateStopHook({ records, stopHookActive: true });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("stop_hook_active");
  });

  it("ignores non-assistant records and malformed tool shapes defensively", () => {
    const records: ClaudeTranscriptRecord[] = [
      { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "assistant", message: { content: "not-an-array" } },
      { type: "assistant", message: {} },
      {},
      // Bash tool_use with no input.command still counts as a command.
      assistant([{ name: "Bash" }]),
      bashes(5),
    ];
    const result = evaluateStopHook({ records, stopHookActive: false });
    expect(result.kind).toBe("nudge");
    if (result.kind !== "nudge") throw new Error("expected nudge");
    expect(result.commandCount).toBe(6);
  });

  it("stays silent for an empty transcript", () => {
    const result = evaluateStopHook({ records: [], stopHookActive: false });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("not_substantive");
  });
});
