import { describe, expect, it } from "vitest";
import { DEFAULT_STOP_HOOK_MIN_EDITS, evaluateStopHook } from "./stop-hook.js";
import type { ClaudeTranscriptRecord } from "./transcript-importer.js";

/** Build an assistant record carrying the given tool_use items. */
function assistant(tools: Array<Record<string, unknown>>): ClaudeTranscriptRecord {
  return {
    type: "assistant",
    timestamp: "2026-06-24T00:00:00.000Z",
    message: { content: tools.map((t) => ({ type: "tool_use", ...t })) },
  };
}

/** N distinct read-only Bash commands as one assistant record. */
function bashes(n: number): ClaudeTranscriptRecord {
  return assistant(
    Array.from({ length: n }, (_, i) => ({ name: "Bash", input: { command: `echo ${i}` } })),
  );
}

/** N file edits as one assistant record. */
function edits(n: number): ClaudeTranscriptRecord {
  return assistant(
    Array.from({ length: n }, (_, i) => ({ name: "Edit", input: { file_path: `/x/f${i}.ts` } })),
  );
}

/** One assistant record running a single Bash command. */
function bash(command: string): ClaudeTranscriptRecord {
  return assistant([{ name: "Bash", input: { command } }]);
}

/** An AskUserQuestion tool_use offering the given option labels for one question. */
function ask(id: string, question: string, options: string[]): Record<string, unknown> {
  return {
    name: "AskUserQuestion",
    id,
    input: { questions: [{ question, options: options.map((label) => ({ label })) }] },
  };
}

/** The result record carrying the chosen answers, linked back by tool_use_id. */
function askResult(id: string, answers: Record<string, string>): ClaudeTranscriptRecord {
  return {
    type: "user",
    toolUseResult: { answers },
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
  };
}

describe("evaluateStopHook (content-aware trigger)", () => {
  it("stays silent for a read-only Bash session (no edits / no strong signal)", () => {
    // The core precision fix: pure exploration (ls / grep / echo) is NOT
    // substantive no matter how many commands, so the hook does not nag.
    const result = evaluateStopHook({ records: [bashes(8)], stopHookActive: false });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("not_substantive");
    expect(result.commandCount).toBe(8);
    expect(result.fileCount).toBe(0);
  });

  it("nudges when the session edited enough files but recorded nothing", () => {
    const result = evaluateStopHook({ records: [edits(2)], stopHookActive: false });
    expect(result.kind).toBe("nudge");
    if (result.kind !== "nudge") throw new Error("expected nudge");
    expect(result.fileCount).toBe(2);
    expect(result.additionalContext).toContain("basou decision capture");
    expect(result.additionalContext).toContain("basou note");
    // It must give the model an out so it does not fabricate decisions.
    expect(result.additionalContext).toContain("just stop");
  });

  it("stays silent for a single trivial edit (below the edit threshold)", () => {
    const result = evaluateStopHook({ records: [edits(1)], stopHookActive: false });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("not_substantive");
  });

  it("uses DEFAULT_STOP_HOOK_MIN_EDITS as the inclusive edit boundary", () => {
    const below = evaluateStopHook({
      records: [edits(DEFAULT_STOP_HOOK_MIN_EDITS - 1)],
      stopHookActive: false,
    });
    expect(below.kind).toBe("silent");
    const at = evaluateStopHook({
      records: [edits(DEFAULT_STOP_HOOK_MIN_EDITS)],
      stopHookActive: false,
    });
    expect(at.kind).toBe("nudge");
  });

  it("honors a custom minEdits threshold", () => {
    const result = evaluateStopHook({ records: [edits(1)], stopHookActive: false, minEdits: 1 });
    expect(result.kind).toBe("nudge");
  });

  it("treats a free-form AskUserQuestion answer as a decision point (substantive)", () => {
    // A free-text reply matches no offered option → the importer does NOT
    // auto-derive it → it is an uncaptured conversational decision worth a nudge.
    const id = "toolu_freeform";
    const records = [
      assistant([ask(id, "Which approach?", ["Approach A", "Approach B"])]),
      askResult(id, { "Which approach?": "Actually, let's reconsider the whole thing" }),
    ];
    const result = evaluateStopHook({ records, stopHookActive: false });
    expect(result.kind).toBe("nudge");
    if (result.kind !== "nudge") throw new Error("expected nudge");
    expect(result.decisionPointCount).toBe(1);
    expect(result.fileCount).toBe(0);
    // The lead clause must describe what actually fired, not misreport "edited 0
    // files" when the trigger was a decision point.
    expect(result.additionalContext).toContain("open-ended question");
    expect(result.additionalContext).not.toContain("edited 0 files");
  });

  it("does NOT treat an exact-option AskUserQuestion answer as a decision point", () => {
    // A confirmed selection is auto-derived as a decision by the importer, so it
    // is not uncaptured and must not, alone, make a session substantive.
    const id = "toolu_exact";
    const records = [
      assistant([ask(id, "Which approach?", ["Approach A", "Approach B"])]),
      askResult(id, { "Which approach?": "Approach A" }),
    ];
    const result = evaluateStopHook({ records, stopHookActive: false });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("not_substantive");
    expect(result.decisionPointCount).toBe(0);
  });

  it("stays silent once a capture verb ran this session (at a segment boundary)", () => {
    for (const command of [
      "basou decision capture <<'JSON'\n[]\nJSON",
      "basou decision record --title x",
      'basou note "next step"',
      'cd /repo && basou note "from a chained command"',
      'echo prep; basou note "after a semicolon"',
      "false || basou decision capture --file d.json",
      // The CLI invoked via its node path — how a non-interactive context runs
      // it when `basou` is a shell alias not on PATH (the SessionStart hook does
      // the same). These must count as a capture, or a session that recorded its
      // intent this way is falsely nudged.
      "node /abs/repo/packages/cli/dist/index.js decision capture --file d.json",
      'node /abs/repo/packages/cli/dist/index.js note "next step"',
      // npm-install path tail (`@basou/cli/dist/index.js`) is recognized too.
      "/usr/bin/node /opt/lib/node_modules/@basou/cli/dist/index.js decision record --title x",
      'cd /repo && node /abs/repo/packages/cli/dist/index.js note "chained node path"',
    ]) {
      const records = [edits(3), assistant([{ name: "Bash", input: { command } }])];
      const result = evaluateStopHook({ records, stopHookActive: false });
      expect(result.kind, command).toBe("silent");
      if (result.kind !== "silent") throw new Error("expected silent");
      expect(result.reason).toBe("already_captured");
    }
  });

  it("does not treat an unrelated basou command as a capture", () => {
    const records = [edits(2), assistant([{ name: "Bash", input: { command: "basou orient" } }])];
    const result = evaluateStopHook({ records, stopHookActive: false });
    expect(result.kind).toBe("nudge");
  });

  it("does not treat a capture verb merely MENTIONED in another command as a capture", () => {
    // A capture verb inside a quoted argument (grep/echo) must not permanently
    // silence the nudge — it only counts when it starts a command segment.
    for (const command of [
      'rg "basou note" packages/',
      'echo "run basou decision capture later"',
      // A node-path invocation mentioned inside another command's argument must
      // also not count — the invocation must start a command segment.
      'echo "run node /a/cli/dist/index.js note later"',
      'rg "cli/dist/index.js note" packages/',
      // An unrelated project's `node …/index.js` is NOT Basou's CLI: the node
      // arm is anchored to the `cli/dist/index.js` tail, so this still nudges.
      "node ./scripts/index.js note draft",
      "node ./dist/index.js decision capture --file d.json",
    ]) {
      const records = [edits(2), assistant([{ name: "Bash", input: { command } }])];
      const result = evaluateStopHook({ records, stopHookActive: false });
      expect(result.kind, command).toBe("nudge");
    }
  });

  it("stays silent (loop guard) when stop_hook_active is true, even if substantive + uncaptured", () => {
    const result = evaluateStopHook({ records: [edits(5)], stopHookActive: true });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("stop_hook_active");
  });

  it("loop guard takes precedence over the already-captured reason", () => {
    const records = [edits(3), assistant([{ name: "Bash", input: { command: "basou note x" } }])];
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
      // Bash tool_use with no input.command still counts toward commandCount.
      assistant([{ name: "Bash" }]),
      edits(2),
    ];
    const result = evaluateStopHook({ records, stopHookActive: false });
    expect(result.kind).toBe("nudge");
    if (result.kind !== "nudge") throw new Error("expected nudge");
    expect(result.fileCount).toBe(2);
    expect(result.commandCount).toBe(1);
  });

  it("stays silent for an empty transcript", () => {
    const result = evaluateStopHook({ records: [], stopHookActive: false });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("not_substantive");
  });

  it("counts edits across multiple records, ignoring read-only Bash for the trigger", () => {
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

  it("attaches a no_ship_act review verdict to an ordinary (non-shipping) session", () => {
    // The review field is additive: an edit-only session that never shipped owes
    // no review, and the capture verdict is unchanged by its presence.
    const result = evaluateStopHook({ records: [edits(2)], stopHookActive: false });
    expect(result.kind).toBe("nudge");
    expect(result.review).toEqual({ fires: false, reason: "no_ship_act" });
  });
});

describe("evaluateStopHook (review gate)", () => {
  it("fires when a substantive-code session shipped (git push) without a review record", () => {
    const result = evaluateStopHook({
      records: [edits(2), bash("git push origin main")],
      stopHookActive: false,
    });
    expect(result.review.fires).toBe(true);
    if (!result.review.fires) throw new Error("expected review to fire");
    expect(result.review.additionalContext).toContain("basou review record");
    expect(result.review.additionalContext).toContain("shipped");
    // It gives the model an out so it does not fabricate a review.
    expect(result.review.additionalContext).toContain("just stop");
  });

  it("fires for each built-in ship act at a segment boundary", () => {
    for (const command of [
      "git push",
      "git push --force-with-lease origin feat/x",
      "git merge main",
      "gh pr create --fill",
      "gh pr merge 146 --squash",
      "cd /repo && git push",
      "npm run build; git push",
      "false || gh pr merge 1",
    ]) {
      const result = evaluateStopHook({
        records: [edits(2), bash(command)],
        stopHookActive: false,
      });
      expect(result.review.fires, command).toBe(true);
    }
  });

  it("stays silent (no_ship_act) when nothing was shipped", () => {
    const result = evaluateStopHook({
      records: [edits(3), bash("git status"), bash("git commit -m x")],
      stopHookActive: false,
    });
    expect(result.review).toEqual({ fires: false, reason: "no_ship_act" });
  });

  it("does not treat a ship verb merely MENTIONED in another command as a ship act", () => {
    for (const command of [
      'echo "git push"',
      'rg "gh pr create" docs/',
      "git pushd", // not a real verb; must not match `git push`
    ]) {
      const result = evaluateStopHook({
        records: [edits(2), bash(command)],
        stopHookActive: false,
      });
      expect(result.review, command).toEqual({ fires: false, reason: "no_ship_act" });
    }
  });

  it("does not classify hyphenated read-only siblings (git merge-base / merge-tree) as ship acts", () => {
    // `\b` would treat the hyphen as a boundary and match these common read-only
    // commands; the `(?![-\w])` lookahead must keep them out.
    for (const command of [
      "git merge-base HEAD main",
      "git merge-tree $(git merge-base A B) A B",
    ]) {
      const result = evaluateStopHook({
        records: [edits(2), bash(command)],
        stopHookActive: false,
      });
      expect(result.review, command).toEqual({ fires: false, reason: "no_ship_act" });
    }
  });

  it("does not classify a dry-run push (--dry-run / -n) as a ship act", () => {
    for (const command of [
      "git push --dry-run",
      "git push -n origin main",
      "git push --dry-run --force-with-lease origin feat/x",
    ]) {
      const result = evaluateStopHook({
        records: [edits(2), bash(command)],
        stopHookActive: false,
      });
      expect(result.review, command).toEqual({ fires: false, reason: "no_ship_act" });
    }
  });

  it("still fires on a real push when an unrelated -n belongs to another command in the line", () => {
    // The dry-run exclusion is scoped to the push's own segment, so `-n` on a
    // preceding command must not clear a real push.
    const result = evaluateStopHook({
      records: [edits(2), bash("git commit -n -m wip && git push origin main")],
      stopHookActive: false,
    });
    expect(result.review.fires).toBe(true);
  });

  it("still fires on a force push (a real ship, not a dry run)", () => {
    const result = evaluateStopHook({
      records: [edits(2), bash("git push --force-with-lease origin feat/x")],
      stopHookActive: false,
    });
    expect(result.review.fires).toBe(true);
  });

  it("stays silent (not_substantive_code) when a ship act had too few file edits", () => {
    const result = evaluateStopHook({
      records: [edits(1), bash("git push")],
      stopHookActive: false,
    });
    expect(result.review).toEqual({ fires: false, reason: "not_substantive_code" });
  });

  it("a free-form decision point alone does NOT make the review gate fire (code only)", () => {
    // The review gate keys on file edits, not on the capture gate's decision
    // point — you review shipped code, not a conversation.
    const id = "toolu_rev_free";
    const records = [
      assistant([ask(id, "Which approach?", ["A", "B"])]),
      askResult(id, { "Which approach?": "let's reconsider entirely" }),
      bash("git push"),
    ];
    const result = evaluateStopHook({ records, stopHookActive: false });
    expect(result.review).toEqual({ fires: false, reason: "not_substantive_code" });
  });

  it("stays silent (already_reviewed) once a review record ran this session", () => {
    for (const command of [
      "basou review record <<'JSON'\n{}\nJSON",
      "basou review record --file r.json",
      "cd /repo && basou review record --file r.json",
      "node /abs/repo/packages/cli/dist/index.js review record --file r.json",
      "/usr/bin/node /opt/node_modules/@basou/cli/dist/index.js review record",
    ]) {
      const result = evaluateStopHook({
        records: [edits(2), bash("git push"), bash(command)],
        stopHookActive: false,
      });
      expect(result.review, command).toEqual({ fires: false, reason: "already_reviewed" });
    }
  });

  it("does not treat a review verb merely MENTIONED in another command as a review record", () => {
    const result = evaluateStopHook({
      records: [edits(2), bash("git push"), bash('echo "run basou review record later"')],
      stopHookActive: false,
    });
    expect(result.review.fires).toBe(true);
  });

  it("does not treat an unrelated basou command as a review record", () => {
    const result = evaluateStopHook({
      records: [edits(2), bash("git push"), bash("basou orient")],
      stopHookActive: false,
    });
    expect(result.review.fires).toBe(true);
  });

  it("is independent of the capture gate: a captured session can still owe a review", () => {
    // Capture is satisfied (decision capture ran) but the session shipped code
    // without a review record — the review gate must still fire.
    const result = evaluateStopHook({
      records: [edits(2), bash("basou decision capture <<'JSON'\n[]\nJSON"), bash("git push")],
      stopHookActive: false,
    });
    expect(result.kind).toBe("silent");
    if (result.kind !== "silent") throw new Error("expected silent");
    expect(result.reason).toBe("already_captured");
    expect(result.review.fires).toBe(true);
  });

  it("the loop guard suppresses the review gate too", () => {
    const result = evaluateStopHook({
      records: [edits(3), bash("git push")],
      stopHookActive: true,
    });
    expect(result.review).toEqual({ fires: false, reason: "stop_hook_active" });
  });
});
