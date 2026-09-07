import type { Manifest } from "@basou/core";

/** Why a workspace's orientation is NOT written to the Codex context face. */
export type CodexChannelSkipReason = "not_enabled" | "confidential";

/**
 * Whether this workspace may render its orientation into `~/.codex/AGENTS.md`.
 *
 * That file is user-global: Codex auto-loads it at startup for every project on
 * the machine, so whatever one workspace writes there is in the context of the
 * next Codex session of ANY other workspace. Writing is therefore opt-in per
 * workspace (`channels.codex: true` in the manifest) and off by default, and
 * `confidential: true` outranks the opt-in — a workspace whose provenance must
 * never leave its own store cannot be re-enabled by a second declaration.
 *
 * This decides writing only. It cannot keep a shared face's existing content
 * out of this workspace's tool; `basou channel clear codex` is for that.
 */
export type CodexChannelDecision =
  | { write: true }
  | { write: false; reason: CodexChannelSkipReason };

export function decideCodexChannel(
  manifest: Pick<Manifest, "channels" | "confidential">,
): CodexChannelDecision {
  if (manifest.confidential === true) return { write: false, reason: "confidential" };
  if (manifest.channels?.codex === true) return { write: true };
  return { write: false, reason: "not_enabled" };
}

/** The one-line status printed when the channel was not written, and why. */
export function describeCodexChannelSkip(reason: CodexChannelSkipReason): string {
  switch (reason) {
    case "confidential":
      return "codex channel: skipped (confidential workspace — nothing is written to the user-global ~/.codex/AGENTS.md)";
    case "not_enabled":
      return "codex channel: skipped (not enabled in manifest — set channels.codex: true to render this workspace's orientation into the user-global ~/.codex/AGENTS.md)";
  }
}
