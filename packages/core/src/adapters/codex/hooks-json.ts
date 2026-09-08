/**
 * Pure transforms for registering / removing basou's SessionStart hook inside a
 * parsed Codex `hooks.json` object. No disk or environment access: the CLI reads
 * and writes the file, parses the JSON, and passes the object here so the
 * merge/removal logic stays deterministic and unit-testable. The Codex twin of
 * the Claude Code `settings-hook` transforms.
 *
 * Why a hook, and why this shape: `~/.codex/hooks.json` is user-global, but a
 * hook stores nothing — Codex runs it when a session starts and passes the
 * session's own `cwd` on stdin, and whatever the hook prints on stdout becomes
 * developer context for THAT session only. basou resolves the workspace from
 * that `cwd` and prints that workspace's position. So one installed hook serves
 * every workspace on the machine while no workspace's position is ever written
 * where another workspace's session reads it — the property the retired
 * `~/.codex/AGENTS.md` orientation render could not have.
 *
 * `hooks.json` holds other events and other people's hooks; these functions
 * clone the input and touch ONLY the `hooks.SessionStart` handler that basou
 * owns, preserving everything else byte-for-byte through the round-trip.
 */

/**
 * Seconds before Codex kills the hook. `basou orient` reads the store and
 * probes the native logs for staleness; on a large store that is seconds, not
 * minutes. Codex's own default is 600 — far too long for a session-start
 * handler whose failure mode is "the session waits".
 */
export const SESSION_START_HOOK_TIMEOUT_SECONDS = 30;

/**
 * Which SessionStart sources fire the hook. Codex applies the matcher to the
 * payload's `source`: `startup` (a new session), `resume`, `clear` (context
 * reset). `compact` is left out: the position is already in the context being
 * compacted, and re-injecting ~10 KB after every compaction would crowd the
 * budget the compaction just freed.
 */
export const SESSION_START_HOOK_MATCHER = "startup|resume|clear";

/**
 * Codex caps each hook's model-visible output at roughly 2,500 tokens by default
 * and spills the rest to a temp file, handing the model a head-and-tail preview
 * plus the path. A position is ~10 KB and is useless truncated — the open
 * tracks and the next step sit at the end — so the cap is disabled for this
 * handler (`0` passes the complete output).
 */
export const SESSION_START_HOOK_CONTEXT_LIMIT = 0;

/** Shown in the Codex UI while the hook runs. */
export const SESSION_START_HOOK_STATUS_MESSAGE = "basou orient";

/**
 * Recognize basou's own SessionStart hook among arbitrary hooks.json commands,
 * so `hook install codex` is idempotent (it upgrades the existing entry rather
 * than duplicating it) and `hook uninstall codex` removes only what basou owns.
 * Same anchoring rules as the Claude Stop hook: the path arm is pinned on
 * `@basou/cli` / `packages/cli` so a foreign tool whose path merely ends in
 * `cli/dist/index.js` is never mistaken for ours.
 */
const BASOU_SESSION_START_HOOK =
  /(?:\bbasou|(?:@basou|packages)\/cli\/dist\/index\.js['"]?)\s+hook\s+session-start\b/;

export function isBasouSessionStartHookCommand(command: string): boolean {
  return BASOU_SESSION_START_HOOK.test(command);
}

/** Wrap a string in single quotes for POSIX sh, escaping any embedded single quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the shell command basou registers as a Codex SessionStart hook. Uses
 * the node path (the `basou` alias is often absent from a hook's PATH) and a
 * `2>/dev/null || true` wrapper so a stale dist path or any crash fails open —
 * a session start must never be blocked by its orientation. The handler itself
 * is also fail-open, so the wrapper is belt-and-braces. The entry path is
 * shell-quoted for directories containing spaces or metacharacters.
 */
export function buildSessionStartHookCommand(options: { cliEntry: string }): string {
  return `node ${shellQuote(options.cliEntry)} hook session-start 2>/dev/null || true`;
}

export type CodexHooksFile = Record<string, unknown>;

export type SessionStartHookUpsert = {
  hooksFile: CodexHooksFile;
  /** `installed` = a new entry was appended; `updated` = an existing basou entry was rewritten; `unchanged` = already canonical. */
  action: "installed" | "updated" | "unchanged";
};

export type SessionStartHookRemoval = {
  hooksFile: CodexHooksFile;
  action: "removed" | "absent";
};

/**
 * Where basou's handler sits in the file. Codex records trust per handler under
 * `[hooks.state."<hooks.json path>:session_start:<group>:<handler>"]` in
 * `config.toml`, so the two indexes are what `hook status codex` needs to look
 * the trust entry up.
 */
export type SessionStartHookLocation = {
  command: string;
  groupIndex: number;
  handlerIndex: number;
  /** The matcher of the group the handler sits in (undefined = fires on every source). */
  matcher: string | undefined;
  /**
   * The handler object exactly as installed. Codex hashes the installed fields
   * (not basou's canonical ones) when it decides whether the hook is trusted, so
   * a status check must hash what is in the file.
   */
  handler: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clone the file for mutation. `null`/`undefined` (no file yet) becomes a fresh
 * object; a non-object (corrupt hooks.json) throws rather than being silently
 * replaced — the caller surfaces it and the user fixes the file.
 */
function cloneHooksFile(hooksFile: unknown): CodexHooksFile {
  if (hooksFile === undefined || hooksFile === null) return {};
  if (!isRecord(hooksFile)) {
    throw new Error("The Codex hooks.json is not a JSON object.");
  }
  return structuredClone(hooksFile) as CodexHooksFile;
}

/** The canonical handler object basou registers. */
function canonicalHandler(command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    timeout: SESSION_START_HOOK_TIMEOUT_SECONDS,
    statusMessage: SESSION_START_HOOK_STATUS_MESSAGE,
    additionalContextLimit: SESSION_START_HOOK_CONTEXT_LIMIT,
  };
}

function handlerIsCanonical(entry: Record<string, unknown>, command: string): boolean {
  const want = canonicalHandler(command);
  return Object.keys(want).every((k) => entry[k] === want[k]);
}

/**
 * Register (or upgrade in place) basou's SessionStart hook. Idempotent: an
 * existing basou handler is rewritten to the canonical fields; a foreign
 * handler, another event, or any other key is left untouched. A new install
 * appends its own matcher group so it never widens or narrows someone else's
 * matcher.
 */
export function upsertSessionStartHook(
  hooksFile: unknown,
  command: string,
): SessionStartHookUpsert {
  const root = cloneHooksFile(hooksFile);

  if (root.hooks === undefined) {
    root.hooks = {};
  } else if (!isRecord(root.hooks)) {
    throw new Error("The 'hooks' key in the Codex hooks.json is not an object.");
  }
  const hooks = root.hooks as Record<string, unknown>;

  if (hooks.SessionStart === undefined) {
    hooks.SessionStart = [];
  } else if (!Array.isArray(hooks.SessionStart)) {
    throw new Error("The 'hooks.SessionStart' key in the Codex hooks.json is not an array.");
  }
  const groups = hooks.SessionStart as unknown[];

  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const entry of group.hooks) {
      if (!isRecord(entry)) continue;
      if (typeof entry.command === "string" && isBasouSessionStartHookCommand(entry.command)) {
        const unchanged = handlerIsCanonical(entry, command);
        Object.assign(entry, canonicalHandler(command));
        return { hooksFile: root, action: unchanged ? "unchanged" : "updated" };
      }
    }
  }

  groups.push({ matcher: SESSION_START_HOOK_MATCHER, hooks: [canonicalHandler(command)] });
  return { hooksFile: root, action: "installed" };
}

/**
 * Remove every basou-owned SessionStart handler. A group emptied by the removal
 * is dropped; a now-empty `hooks.SessionStart` / `hooks` container is deleted so
 * the file does not accumulate empty scaffolding. Foreign handlers and other
 * keys are preserved.
 */
export function removeSessionStartHook(hooksFile: unknown): SessionStartHookRemoval {
  const root = cloneHooksFile(hooksFile);
  if (!isRecord(root.hooks) || !Array.isArray(root.hooks.SessionStart)) {
    return { hooksFile: root, action: "absent" };
  }
  const hooks = root.hooks as Record<string, unknown>;
  const groups = hooks.SessionStart as unknown[];

  let removed = false;
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const keptHandlers = group.hooks.filter((entry) => {
      if (
        isRecord(entry) &&
        typeof entry.command === "string" &&
        isBasouSessionStartHookCommand(entry.command)
      ) {
        removed = true;
        return false;
      }
      return true;
    });
    if (keptHandlers.length === group.hooks.length) {
      kept.push(group);
    } else if (keptHandlers.length > 0) {
      group.hooks = keptHandlers;
      kept.push(group);
    }
    // else: the group held only basou handlers and is now empty -> drop it
  }

  if (!removed) return { hooksFile: root, action: "absent" };

  if (kept.length === 0) {
    delete hooks.SessionStart;
  } else {
    hooks.SessionStart = kept;
  }
  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
  }
  return { hooksFile: root, action: "removed" };
}

/** Locate the installed basou SessionStart handler, or null if none is registered. */
export function findBasouSessionStartHook(hooksFile: unknown): SessionStartHookLocation | null {
  if (
    !isRecord(hooksFile) ||
    !isRecord(hooksFile.hooks) ||
    !Array.isArray(hooksFile.hooks.SessionStart)
  ) {
    return null;
  }
  const groups = hooksFile.hooks.SessionStart;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (let h = 0; h < group.hooks.length; h++) {
      const entry = group.hooks[h];
      if (
        isRecord(entry) &&
        typeof entry.command === "string" &&
        isBasouSessionStartHookCommand(entry.command)
      ) {
        return {
          command: entry.command,
          groupIndex: g,
          handlerIndex: h,
          matcher: typeof group.matcher === "string" ? group.matcher : undefined,
          handler: structuredClone(entry),
        };
      }
    }
  }
  return null;
}
