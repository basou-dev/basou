import { describe, expect, it } from "vitest";
import {
  codexHookStateKey,
  commandHandlerFields,
  computeCodexHookIdentityHash,
  describeCodexHookTrust,
  judgeCodexHookTrust,
  readCodexHookState,
} from "./codex-hook-trust.js";

/**
 * Pins the reproduction of Codex's identity hash. The algorithm was verified
 * on 2026-09-08 against a record codex-cli 0.153.4 wrote to config.toml after
 * trusting a hooks.json entry with these fields (matcher, timeout, status
 * message, context limit): the reproduced hash matched the recorded one bit
 * for bit. The command path here is synthetic — the real one carried a local
 * home directory — so the expected hash below is the algorithm's output for
 * this fixture, and the test guards the reproduction against drift.
 */
const REAL = {
  command: "/Users/example/.codex/hooks/basou-canary.sh",
  matcher: "startup|resume|clear",
  handler: {
    type: "command",
    command: "",
    timeout: 10,
    statusMessage: "basou canary (temporary verification hook)",
    additionalContextLimit: 0,
  },
  hash: "sha256:05ec130b85049e1c54ebbe2857ae5f0f9306584d7fc176b6e18bfd85d9b1cf76",
};
REAL.handler.command = REAL.command;

describe("computeCodexHookIdentityHash", () => {
  it("reproduces the hash Codex recorded for a real trusted hook", () => {
    const fields = commandHandlerFields(REAL.handler);
    if (fields === null) throw new Error("fixture");
    expect(
      computeCodexHookIdentityHash({
        eventKey: "session_start",
        matcher: REAL.matcher,
        handler: fields,
      }),
    ).toBe(REAL.hash);
  });

  it("normalizes like Codex: default timeout 600, async false, the 2500 context default dropped", () => {
    const bare = computeCodexHookIdentityHash({
      eventKey: "session_start",
      matcher: undefined,
      handler: { command: "x" },
    });
    const explicitDefaults = computeCodexHookIdentityHash({
      eventKey: "session_start",
      matcher: undefined,
      handler: { command: "x", timeout: 600, async: false, additionalContextLimit: 2500 },
    });
    expect(explicitDefaults).toBe(bare);
    // a non-default limit changes the identity; so does the matcher; so does the event
    expect(
      computeCodexHookIdentityHash({
        eventKey: "session_start",
        matcher: undefined,
        handler: { command: "x", additionalContextLimit: 0 },
      }),
    ).not.toBe(bare);
    expect(
      computeCodexHookIdentityHash({
        eventKey: "session_start",
        matcher: "startup",
        handler: { command: "x" },
      }),
    ).not.toBe(bare);
    expect(
      computeCodexHookIdentityHash({
        eventKey: "stop",
        matcher: undefined,
        handler: { command: "x" },
      }),
    ).not.toBe(bare);
  });

  it("commandHandlerFields ignores a non-command handler", () => {
    expect(commandHandlerFields({ type: "mcp_tool", server: "s", tool: "t" })).toBeNull();
  });
});

describe("codexHookStateKey / readCodexHookState", () => {
  const key = codexHookStateKey("/Users/example/.codex/hooks.json", "session_start", 0, 0);

  it("builds the position-based key Codex uses", () => {
    expect(key).toBe("/Users/example/.codex/hooks.json:session_start:0:0");
  });

  it("reads trusted_hash (and enabled) from the matching [hooks.state] table only", () => {
    const toml = [
      'model = "gpt"',
      "",
      "[hooks.state]",
      "",
      `[hooks.state."${key}"]`,
      `trusted_hash = "${REAL.hash}"`,
      "",
      '[hooks.state."/Users/example/.codex/hooks.json:session_start:1:0"]',
      'trusted_hash = "sha256:other"',
      "enabled = false",
      "",
      "[other]",
      'trusted_hash = "sha256:not-a-hook"',
    ].join("\n");
    expect(readCodexHookState(toml, key)).toEqual({
      kind: "found",
      state: { trustedHash: REAL.hash },
    });
    expect(
      readCodexHookState(
        toml,
        codexHookStateKey("/Users/example/.codex/hooks.json", "session_start", 1, 0),
      ),
    ).toEqual({ kind: "found", state: { trustedHash: "sha256:other", enabled: false } });
    expect(readCodexHookState(toml, "/elsewhere:session_start:0:0")).toEqual({ kind: "absent" });
  });

  it("matches a key whose path needs TOML escaping", () => {
    const odd = codexHookStateKey('/Users/example"quoted/.codex/hooks.json', "session_start", 0, 0);
    const toml = `[hooks.state."/Users/exam\\"ple/.codex/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:x"\n`;
    expect(readCodexHookState(toml, odd)).toEqual({
      kind: "found",
      state: { trustedHash: "sha256:x" },
    });
  });

  it("tolerates TOML comments and literal-quoted keys and values", () => {
    const toml = [
      `[hooks.state."${key}"] # basou`,
      `trusted_hash = "${REAL.hash}" # ok`,
      "",
      "[hooks.state.'/Users/example/.codex/hooks.json:session_start:2:0']",
      "trusted_hash = 'sha256:lit'",
    ].join("\n");
    expect(readCodexHookState(toml, key)).toEqual({
      kind: "found",
      state: { trustedHash: REAL.hash },
    });
    expect(
      readCodexHookState(
        toml,
        codexHookStateKey("/Users/example/.codex/hooks.json", "session_start", 2, 0),
      ),
    ).toEqual({ kind: "found", state: { trustedHash: "sha256:lit" } });
  });

  it("reports a record it cannot read as unreadable, never as absent", () => {
    const inline = `hooks.state = { "${key}" = { trusted_hash = "sha256:x" } }`;
    expect(readCodexHookState(inline, key)).toMatchObject({ kind: "unreadable" });
    const badValue = `[hooks.state."${key}"]\ntrusted_hash = 12345\n`;
    expect(readCodexHookState(badValue, key)).toMatchObject({ kind: "unreadable" });
  });
});

describe("judgeCodexHookTrust / describeCodexHookTrust", () => {
  const found = (state: { trustedHash?: string; enabled?: boolean }) =>
    ({ kind: "found", state }) as const;

  it("maps Codex's states: absent => untrusted, match => trusted, mismatch => modified, enabled=false => disabled, unreadable => unknown", () => {
    expect(judgeCodexHookTrust({ kind: "absent" }, "sha256:a")).toEqual({ status: "untrusted" });
    expect(judgeCodexHookTrust(found({}), "sha256:a")).toEqual({ status: "untrusted" });
    expect(judgeCodexHookTrust(found({ trustedHash: "sha256:a" }), "sha256:a")).toEqual({
      status: "trusted",
    });
    expect(judgeCodexHookTrust(found({ trustedHash: "sha256:b" }), "sha256:a")).toEqual({
      status: "modified",
    });
    expect(
      judgeCodexHookTrust(found({ trustedHash: "sha256:a", enabled: false }), "sha256:a"),
    ).toEqual({ status: "disabled" });
    expect(judgeCodexHookTrust({ kind: "unreadable", detail: "why" }, "sha256:a")).toEqual({
      status: "unknown",
      detail: "why",
    });
  });

  it("describes every state in one line", () => {
    for (const t of [
      { status: "trusted" as const },
      { status: "untrusted" as const },
      { status: "modified" as const },
      { status: "disabled" as const },
      { status: "unknown" as const, detail: "why" },
    ]) {
      expect(describeCodexHookTrust(t).length).toBeGreaterThan(0);
    }
    expect(describeCodexHookTrust({ status: "unknown", detail: "why" })).toContain("why");
    expect(describeCodexHookTrust({ status: "modified" })).toContain("does not match");
  });
});
