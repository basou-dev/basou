import { createHash } from "node:crypto";

/**
 * How Codex decides whether a configured hook is trusted, reproduced so `basou
 * hook status codex` can say "registered but not yet trusted" instead of
 * guessing. Verified against a real trust record on codex-cli 0.153.4.
 *
 * Codex (codex-rs/hooks/src/engine/discovery.rs) hashes a NORMALIZED identity
 * rather than the source text, so a hooks.json entry and an equivalent
 * config.toml entry converge on one identity:
 *
 *   { event_name: "session_start", matcher?: <group matcher>, hooks: [handler] }
 *
 * where the command handler is normalized to `type: "command"`, `command`,
 * `timeout` (the configured seconds, or Codex's 600 default, floored at 1),
 * `async` (false unless set), `statusMessage` if set, and `additionalContextLimit`
 * only when set to something other than the 2,500 default. Absent options are
 * dropped (the identity round-trips through TOML, which has no null). The
 * object is then canonicalized (keys sorted recursively), serialized as compact
 * JSON, and SHA-256'd: `sha256:<hex>`.
 *
 * Codex records the result in `~/.codex/config.toml` as
 * `[hooks.state."<hooks.json path>:<event key>:<group index>:<handler index>"]
 * trusted_hash = "sha256:..."`, and treats the hook as trusted only while the
 * recorded hash equals the current one.
 */

/** Codex's default `additionalContextLimit`; a handler set to exactly this hashes as if unset. */
const CODEX_DEFAULT_CONTEXT_LIMIT = 2500;
/** Codex's default command-hook timeout in seconds. */
const CODEX_DEFAULT_TIMEOUT_SECONDS = 600;

export type CodexCommandHandlerFields = {
  command: string;
  timeout?: number | undefined;
  async?: boolean | undefined;
  statusMessage?: string | undefined;
  additionalContextLimit?: number | undefined;
};

/** Reduce an installed handler object to the fields Codex's identity hash reads. */
export function commandHandlerFields(
  handler: Record<string, unknown>,
): CodexCommandHandlerFields | null {
  if (handler.type !== "command" || typeof handler.command !== "string") return null;
  const out: CodexCommandHandlerFields = { command: handler.command };
  if (typeof handler.timeout === "number") out.timeout = handler.timeout;
  if (typeof handler.async === "boolean") out.async = handler.async;
  if (typeof handler.statusMessage === "string") out.statusMessage = handler.statusMessage;
  if (typeof handler.additionalContextLimit === "number")
    out.additionalContextLimit = handler.additionalContextLimit;
  return out;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

/** Codex's identity hash for one command hook, as it would appear in `trusted_hash`. */
export function computeCodexHookIdentityHash(input: {
  eventKey: string;
  matcher: string | undefined;
  handler: CodexCommandHandlerFields;
}): string {
  const h = input.handler;
  const normalized: Record<string, unknown> = {
    type: "command",
    command: h.command,
    timeout: Math.max(1, h.timeout ?? CODEX_DEFAULT_TIMEOUT_SECONDS),
    async: h.async ?? false,
  };
  if (h.statusMessage !== undefined) normalized.statusMessage = h.statusMessage;
  if (
    h.additionalContextLimit !== undefined &&
    h.additionalContextLimit !== CODEX_DEFAULT_CONTEXT_LIMIT
  ) {
    normalized.additionalContextLimit = h.additionalContextLimit;
  }
  const identity: Record<string, unknown> = { event_name: input.eventKey, hooks: [normalized] };
  if (input.matcher !== undefined) identity.matcher = input.matcher;
  const blob = JSON.stringify(canonicalize(identity));
  return `sha256:${createHash("sha256").update(blob, "utf8").digest("hex")}`;
}

/** The `[hooks.state]` key Codex uses for a handler at a given position in a hooks file. */
export function codexHookStateKey(
  hooksPath: string,
  eventKey: string,
  groupIndex: number,
  handlerIndex: number,
): string {
  return `${hooksPath}:${eventKey}:${groupIndex}:${handlerIndex}`;
}

export type CodexHookState = {
  trustedHash?: string | undefined;
  enabled?: boolean | undefined;
};

/** Escape a string the way TOML writes a basic (double-quoted) key or value. */
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Read one handler's trust record out of a Codex `config.toml`. Deliberately
 * not a TOML parser: it looks for the table header
 * `[hooks.state."<key>"]` and reads the plain `key = value` lines that follow
 * it, up to the next table header. That is the shape Codex writes; anything
 * more exotic (an inline table, a dotted key elsewhere) returns null, and the
 * caller says "unknown" rather than guessing.
 */
export function readCodexHookState(configToml: string, key: string): CodexHookState | null {
  const header = `[hooks.state.${tomlBasicString(key)}]`;
  const lines = configToml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return null;
  const state: CodexHookState = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith("[")) break;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(line);
    if (m === null) continue;
    const [, k, rawValue] = m;
    const v = (rawValue ?? "").trim();
    if (k === "trusted_hash") {
      const str = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
      if (str?.[1] !== undefined) state.trustedHash = str[1].replace(/\\(.)/g, "$1");
    } else if (k === "enabled") {
      if (v === "true") state.enabled = true;
      else if (v === "false") state.enabled = false;
    }
  }
  return state;
}

export type CodexHookTrust =
  | { status: "trusted" }
  | { status: "untrusted" }
  | { status: "modified" }
  | { status: "disabled" }
  | { status: "unknown"; detail: string };

/**
 * Codex's verdict for an installed handler, derived the way Codex derives it:
 * no state record → untrusted (review pending); a record whose hash matches →
 * trusted; a record whose hash differs → modified since trusted (review
 * required again); `enabled = false` → disabled by the operator.
 */
export function judgeCodexHookTrust(
  state: CodexHookState | null,
  currentHash: string,
): CodexHookTrust {
  if (state === null) return { status: "untrusted" };
  if (state.enabled === false) return { status: "disabled" };
  if (state.trustedHash === undefined) return { status: "untrusted" };
  return state.trustedHash === currentHash ? { status: "trusted" } : { status: "modified" };
}

export function describeCodexHookTrust(trust: CodexHookTrust): string {
  switch (trust.status) {
    case "trusted":
      return "trusted by Codex";
    case "untrusted":
      return "not yet trusted by Codex (review pending — it is skipped until you trust it)";
    case "modified":
      return "changed since Codex trusted it (review required again — it is skipped until re-trusted)";
    case "disabled":
      return "disabled in the Codex config (enabled = false)";
    case "unknown":
      return `trust state unknown (${trust.detail})`;
  }
}
