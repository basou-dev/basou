import { describe, expect, it } from "vitest";
import {
  type CommandLookup,
  claudeCodeAdapterMetadata,
  resolveClaudeCodeCommand,
  summarizeAdapterOutput,
} from "./claude-code-adapter.js";

describe("claudeCodeAdapterMetadata", () => {
  it("has the documented shape used by session.yaml.source", () => {
    expect(claudeCodeAdapterMetadata).toEqual({
      kind: "claude-code-adapter",
      version: "0.1.0",
    });
  });
});

describe("resolveClaudeCodeCommand", () => {
  it("returns 'claude-code' when the primary candidate is on PATH", async () => {
    const lookup: CommandLookup = async (cmd) => cmd === "claude-code";
    const resolved = await resolveClaudeCodeCommand(lookup);
    expect(resolved).toEqual({ command: "claude-code" });
  });

  it("falls back to 'claude' when only the secondary candidate is on PATH", async () => {
    const lookup: CommandLookup = async (cmd) => cmd === "claude";
    const resolved = await resolveClaudeCodeCommand(lookup);
    expect(resolved).toEqual({ command: "claude" });
  });

  it("throws a fixed-message Error when neither candidate is on PATH", async () => {
    const lookup: CommandLookup = async () => false;
    await expect(resolveClaudeCodeCommand(lookup)).rejects.toThrow(
      "Claude Code CLI not found in PATH. Install claude-code (or claude) first.",
    );
  });

  it("matches the not-found message exactly (contract)", async () => {
    const lookup: CommandLookup = async () => false;
    let err: unknown;
    try {
      await resolveClaudeCodeCommand(lookup);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "Claude Code CLI not found in PATH. Install claude-code (or claude) first.",
    );
  });
});

describe("summarizeAdapterOutput (stub)", () => {
  it("throws to signal the v0.1 Step 11 deferred state", () => {
    expect(() => summarizeAdapterOutput("stdout", "anything")).toThrow(
      "adapter_output summary is not implemented in v0.1 Step 11",
    );
  });
});
