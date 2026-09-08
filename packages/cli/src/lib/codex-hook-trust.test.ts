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
 * A real trust record. On 2026-09-08 codex-cli 0.153.4 wrote exactly this hash
 * to config.toml after trusting a hooks.json entry with exactly these fields;
 * the test pins that basou reproduces Codex's identity hash bit for bit.
 */
const REAL = {
  command:
    "/private/tmp/claude-501/-Users-takashi-matsuyama-projects-basou-workspace/5a05f29e-fd1d-4949-bfd8-6a2c0781680a/scratchpad/desktop-verify/canary-hook.sh",
  matcher: "startup|resume|clear",
  handler: {
    type: "command",
    command: "",
    timeout: 10,
    statusMessage: "basou canary (temporary verification hook)",
    additionalContextLimit: 0,
  },
  hash: "sha256:d759aefcb791f4ec1e6c426bdb242cc2f0e577329233ce627106dcd2e66a4fc1",
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
  const key = codexHookStateKey("/Users/me/.codex/hooks.json", "session_start", 0, 0);

  it("builds the position-based key Codex uses", () => {
    expect(key).toBe("/Users/me/.codex/hooks.json:session_start:0:0");
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
      '[hooks.state."/Users/me/.codex/hooks.json:session_start:1:0"]',
      'trusted_hash = "sha256:other"',
      "enabled = false",
      "",
      "[other]",
      'trusted_hash = "sha256:not-a-hook"',
    ].join("\n");
    expect(readCodexHookState(toml, key)).toEqual({ trustedHash: REAL.hash });
    expect(
      readCodexHookState(
        toml,
        codexHookStateKey("/Users/me/.codex/hooks.json", "session_start", 1, 0),
      ),
    ).toEqual({
      trustedHash: "sha256:other",
      enabled: false,
    });
    expect(readCodexHookState(toml, "/elsewhere:session_start:0:0")).toBeNull();
  });

  it("matches a key whose path needs TOML escaping", () => {
    const odd = codexHookStateKey('/Users/o"dd/.codex/hooks.json', "session_start", 0, 0);
    const toml = `[hooks.state."/Users/o\\"dd/.codex/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:x"\n`;
    expect(readCodexHookState(toml, odd)).toEqual({ trustedHash: "sha256:x" });
  });
});

describe("judgeCodexHookTrust / describeCodexHookTrust", () => {
  it("maps Codex's states: none => untrusted, match => trusted, mismatch => modified, enabled=false => disabled", () => {
    expect(judgeCodexHookTrust(null, "sha256:a")).toEqual({ status: "untrusted" });
    expect(judgeCodexHookTrust({}, "sha256:a")).toEqual({ status: "untrusted" });
    expect(judgeCodexHookTrust({ trustedHash: "sha256:a" }, "sha256:a")).toEqual({
      status: "trusted",
    });
    expect(judgeCodexHookTrust({ trustedHash: "sha256:b" }, "sha256:a")).toEqual({
      status: "modified",
    });
    expect(judgeCodexHookTrust({ trustedHash: "sha256:a", enabled: false }, "sha256:a")).toEqual({
      status: "disabled",
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
  });
});
