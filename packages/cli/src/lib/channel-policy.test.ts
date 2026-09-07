import { describe, expect, it } from "vitest";
import { decideCodexChannel, describeCodexChannelSkip } from "./channel-policy.js";

describe("decideCodexChannel", () => {
  it("is off when the manifest declares nothing (default off)", () => {
    expect(decideCodexChannel({})).toEqual({ write: false, reason: "not_enabled" });
  });

  it("is off when channels.codex is explicitly false", () => {
    expect(decideCodexChannel({ channels: { codex: false } })).toEqual({
      write: false,
      reason: "not_enabled",
    });
  });

  it("writes only on an explicit channels.codex: true", () => {
    expect(decideCodexChannel({ channels: { codex: true } })).toEqual({ write: true });
  });

  it("lets confidential outrank the opt-in", () => {
    expect(decideCodexChannel({ channels: { codex: true }, confidential: true })).toEqual({
      write: false,
      reason: "confidential",
    });
  });

  it("names the user-global file in every skip line, so the reader learns what was not written", () => {
    for (const reason of ["not_enabled", "confidential"] as const) {
      const line = describeCodexChannelSkip(reason);
      expect(line).toContain("codex channel: skipped");
      expect(line).toContain("~/.codex/AGENTS.md");
    }
    expect(describeCodexChannelSkip("not_enabled")).toContain("channels.codex: true");
  });
});
