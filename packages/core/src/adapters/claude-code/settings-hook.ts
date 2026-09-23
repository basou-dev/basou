/**
 * Pure transforms for registering / removing basou's Stop hook inside a parsed
 * Claude Code settings.json object. No disk or environment access: the CLI reads
 * and writes the file, parses the JSON, and passes the object here so the
 * merge/removal logic stays deterministic and unit-testable.
 *
 * settings.json holds many unrelated keys (permissions, model, other hooks);
 * these functions clone the input and touch ONLY the `hooks.Stop` and
 * `hooks.SessionStart` entries that basou owns, preserving everything else
 * byte-for-byte through the round-trip.
 *
 * The SessionStart command, matcher and timeout are the Codex twin's
 * (`../codex/hooks-json.ts`): both tools run the same `basou hook session-start`
 * and apply the matcher to the same session sources (startup / resume / clear /
 * compact), so one decision about when the position is worth its bytes serves
 * both.
 */

import {
  isBasouSessionStartHookCommand,
  SESSION_START_HOOK_MATCHER,
  SESSION_START_HOOK_TIMEOUT_SECONDS,
} from "../codex/hooks-json.js";

/** Seconds before Claude Code kills the Stop hook process. */
export const STOP_HOOK_TIMEOUT_SECONDS = 20;

/**
 * Recognize basou's own Stop hook among arbitrary settings.json hook commands,
 * so `hook install` is idempotent (it upgrades the existing entry rather than
 * duplicating it) and `hook uninstall` removes only what basou owns. Matches:
 *   - the npm node path `@basou/cli/dist/index.js hook stop`,
 *   - the source/dogfood node path `…/packages/cli/dist/index.js hook stop`,
 *   - the bare `basou hook stop` alias,
 * regardless of trailing flags or the `2>/dev/null || true` wrapper, and with
 * the registered path optionally shell-quoted (the `['"]?` after `index.js`).
 *
 * The path arm is anchored on `@basou/cli` / `packages/cli` (NOT a bare
 * `cli/dist/index.js`) so a FOREIGN tool whose path merely ends in
 * `cli/dist/index.js` — e.g. `/x/some-cli/dist/index.js hook stop` — is not
 * mistaken for ours and silently rewritten or, worse, deleted by uninstall.
 * A different monorepo whose own `packages/cli` also ships a `hook stop` verb
 * is the only residual collision, and is acceptably unlikely.
 */
const BASOU_STOP_HOOK =
  /(?:\bbasou|(?:@basou|packages)\/cli\/dist\/index\.js['"]?)\s+hook\s+stop\b/;

export function isBasouStopHookCommand(command: string): boolean {
  return BASOU_STOP_HOOK.test(command);
}

export type BuildStopHookCommandOptions = {
  /** Absolute path to the CLI entry to invoke (the running dist/index.js). */
  cliEntry: string;
  /** Register the blocking (opt-in enforcement) form. */
  block?: boolean;
  /** Enable the opt-in review gate (adds `--require-review`). */
  requireReview?: boolean;
  /** Override the file-edit threshold passed to `hook stop`. */
  minEdits?: number;
};

/** Wrap a string in single quotes for POSIX sh, escaping any embedded single quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the shell command basou registers as a Stop hook. Uses the node path
 * (not the `basou` alias, which is often absent from a non-interactive hook's
 * PATH) and a `2>/dev/null || true` wrapper so a stale/incorrect dist path or
 * any crash fails open — no per-turn error noise. The wrapper is safe for the
 * blocking form because that emits `decision:"block"` on stdout with exit 0;
 * `|| true` would defeat an exit-2 block but leaves the JSON form intact.
 *
 * The entry path is shell-quoted so a home/project directory containing spaces
 * or shell metacharacters still invokes correctly (an unquoted path with a
 * space would split into the wrong argv and the hook would silently no-op).
 */
export function buildStopHookCommand(options: BuildStopHookCommandOptions): string {
  const flags: string[] = [];
  if (options.block === true) flags.push("--block");
  if (options.requireReview === true) flags.push("--require-review");
  if (options.minEdits !== undefined) flags.push(`--min-edits ${options.minEdits}`);
  const suffix = flags.length > 0 ? ` ${flags.join(" ")}` : "";
  return `node ${shellQuote(options.cliEntry)} hook stop${suffix} 2>/dev/null || true`;
}

export type ClaudeSettings = Record<string, unknown>;

export type StopHookUpsert = {
  settings: ClaudeSettings;
  /** `installed` = a new entry was appended; `updated` = an existing basou entry was rewritten; `unchanged` = already canonical. */
  action: "installed" | "updated" | "unchanged";
};

export type StopHookRemoval = {
  settings: ClaudeSettings;
  action: "removed" | "absent";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clone the settings for mutation. `null`/`undefined` (no file yet) becomes a
 * fresh object; a non-object (corrupt settings.json) throws rather than being
 * silently replaced — the caller surfaces it and the user fixes the file.
 */
function cloneSettings(settings: unknown): ClaudeSettings {
  if (settings === undefined || settings === null) return {};
  if (!isRecord(settings)) {
    throw new Error("Claude settings is not a JSON object.");
  }
  return structuredClone(settings) as ClaudeSettings;
}

/**
 * Register (or upgrade in place) basou's Stop hook. Idempotent: an existing
 * basou Stop hook is rewritten to the canonical command + timeout; a foreign
 * Stop hook or any other settings key is left untouched.
 */
export function upsertStopHook(settings: unknown, command: string): StopHookUpsert {
  const root = cloneSettings(settings);

  if (root.hooks === undefined) {
    root.hooks = {};
  } else if (!isRecord(root.hooks)) {
    throw new Error("The 'hooks' key in Claude settings is not an object.");
  }
  const hooks = root.hooks as Record<string, unknown>;

  if (hooks.Stop === undefined) {
    hooks.Stop = [];
  } else if (!Array.isArray(hooks.Stop)) {
    throw new Error("The 'hooks.Stop' key in Claude settings is not an array.");
  }
  const stop = hooks.Stop as unknown[];

  for (const group of stop) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const entry of group.hooks) {
      if (!isRecord(entry)) continue;
      if (typeof entry.command === "string" && isBasouStopHookCommand(entry.command)) {
        const unchanged =
          entry.type === "command" &&
          entry.command === command &&
          entry.timeout === STOP_HOOK_TIMEOUT_SECONDS;
        entry.type = "command";
        entry.command = command;
        entry.timeout = STOP_HOOK_TIMEOUT_SECONDS;
        return { settings: root, action: unchanged ? "unchanged" : "updated" };
      }
    }
  }

  stop.push({ hooks: [{ type: "command", command, timeout: STOP_HOOK_TIMEOUT_SECONDS }] });
  return { settings: root, action: "installed" };
}

/**
 * Remove every basou-owned Stop hook. A group emptied by the removal is dropped;
 * a now-empty `hooks.Stop` / `hooks` container is deleted so the file does not
 * accumulate empty scaffolding. Foreign hooks and other keys are preserved.
 */
export function removeStopHook(settings: unknown): StopHookRemoval {
  const root = cloneSettings(settings);
  if (!isRecord(root.hooks) || !Array.isArray(root.hooks.Stop)) {
    return { settings: root, action: "absent" };
  }
  const hooks = root.hooks as Record<string, unknown>;
  const stop = hooks.Stop as unknown[];

  let removed = false;
  const newStop: unknown[] = [];
  for (const group of stop) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      newStop.push(group);
      continue;
    }
    const keptHooks = group.hooks.filter((entry) => {
      if (
        isRecord(entry) &&
        typeof entry.command === "string" &&
        isBasouStopHookCommand(entry.command)
      ) {
        removed = true;
        return false;
      }
      return true;
    });
    if (keptHooks.length === group.hooks.length) {
      newStop.push(group); // nothing removed from this group
    } else if (keptHooks.length > 0) {
      group.hooks = keptHooks; // some basou hooks removed, others kept
      newStop.push(group);
    }
    // else: the group held only basou hooks and is now empty -> drop it
  }

  if (!removed) {
    return { settings: root, action: "absent" };
  }

  if (newStop.length === 0) {
    delete hooks.Stop;
  } else {
    hooks.Stop = newStop;
  }
  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
  }
  return { settings: root, action: "removed" };
}

/** Return the installed basou Stop hook command, or null if none is registered. */
export function findBasouStopHookCommand(settings: unknown): string | null {
  if (!isRecord(settings) || !isRecord(settings.hooks) || !Array.isArray(settings.hooks.Stop)) {
    return null;
  }
  for (const group of settings.hooks.Stop) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const entry of group.hooks) {
      if (
        isRecord(entry) &&
        typeof entry.command === "string" &&
        isBasouStopHookCommand(entry.command)
      ) {
        return entry.command;
      }
    }
  }
  return null;
}

// --- SessionStart --------------------------------------------------------

/**
 * The documented hand-registered form: `basou orient` as a Claude Code
 * SessionStart hook. basou's own reference told Claude Code users to register
 * exactly this before `basou hook install` could, so an install that ignored it
 * would leave both in place and put the position into every session twice.
 * It is treated as basou's own ONLY inside `hooks.SessionStart` — `basou orient`
 * anywhere else is somebody's script and is not touched.
 *
 * ANCHORED ON THE WHOLE COMMAND, unlike the Stop and `hook session-start`
 * recognizers. An entry recognized here is rewritten wholesale, so a match
 * inside `cd ~/work && basou orient` would silently delete the `cd` the user
 * wrote. Only the documented shape is basou's: `basou orient`, or
 * `node <entry> orient` with the entry pinned on `@basou/cli` / `packages/cli`
 * (quoted or not), optional flags, and the optional `2>/dev/null || true`
 * wrapper. Anything longer is left alone — see
 * {@link findUnrecognizedOrientSessionStart} for how that is reported.
 */
const BASOU_CLI_INVOCATION = String.raw`(?:basou|node\s+(?:'[^']*(?:@basou|packages)/cli/dist/index\.js'|"[^"]*(?:@basou|packages)/cli/dist/index\.js"|\S*(?:@basou|packages)/cli/dist/index\.js))`;
const BASOU_ORIENT_SESSION_START = new RegExp(
  String.raw`^\s*${BASOU_CLI_INVOCATION}\s+orient(?:\s+--?[A-Za-z][\w-]*(?:=\S+)?)*(?:\s+2>\s*/dev/null)?(?:\s*\|\|\s*true)?\s*$`,
);

/** Any mention of `orient` run through basou, whatever surrounds it. */
const MENTIONS_BASOU_ORIENT = new RegExp(String.raw`${BASOU_CLI_INVOCATION}\s+orient\b`);

export function isBasouOrientSessionStartCommand(command: string): boolean {
  return BASOU_ORIENT_SESSION_START.test(command);
}

/** Which of basou's two SessionStart forms a command is, if either. */
export type ClaudeSessionStartHookKind = "session-start" | "orient";

function basouSessionStartKind(entry: unknown): ClaudeSessionStartHookKind | null {
  if (!isRecord(entry) || typeof entry.command !== "string") return null;
  if (isBasouSessionStartHookCommand(entry.command)) return "session-start";
  if (isBasouOrientSessionStartCommand(entry.command)) return "orient";
  return null;
}

export type ClaudeSessionStartHookUpsert = {
  settings: ClaudeSettings;
  /**
   * `installed` = a new group was appended; `updated` = an existing
   * `hook session-start` entry was rewritten; `replaced` = a hand-registered
   * `basou orient` entry was rewritten into `hook session-start`;
   * `unchanged` = already canonical.
   */
  action: "installed" | "updated" | "replaced" | "unchanged";
};

export type ClaudeSessionStartHookRemoval = {
  settings: ClaudeSettings;
  action: "removed" | "absent";
};

/**
 * Register (or upgrade in place) basou's SessionStart hook in Claude Code's
 * settings. The hook prints the workspace's position into the new session's
 * context, and records the git baseline the Stop hook measures the session's
 * file changes against — without it, a session's shell edits are invisible.
 *
 * - An existing basou entry — `hook session-start`, or the hand-registered
 *   `basou orient` — is rewritten IN PLACE to the canonical command + timeout.
 *   Its group's matcher is left as it is: the matcher is when the hook fires,
 *   and the person who wrote it may have chosen it. Only a new install brings
 *   basou's own matcher, in a group of its own, so it never widens or narrows
 *   anyone else's. This is the same rule as the Codex twin.
 * - Any FURTHER basou entry is removed (a group it leaves empty is dropped).
 *   Two of them — `orient` and `hook session-start` side by side, which the two
 *   documented setups can produce — would put the position in twice.
 * - Foreign hooks, other events and other keys are untouched.
 */
export function upsertClaudeSessionStartHook(
  settings: unknown,
  command: string,
): ClaudeSessionStartHookUpsert {
  const root = cloneSettings(settings);

  if (root.hooks === undefined) {
    root.hooks = {};
  } else if (!isRecord(root.hooks)) {
    throw new Error("The 'hooks' key in Claude settings is not an object.");
  }
  const hooks = root.hooks as Record<string, unknown>;

  if (hooks.SessionStart === undefined) {
    hooks.SessionStart = [];
  } else if (!Array.isArray(hooks.SessionStart)) {
    throw new Error("The 'hooks.SessionStart' key in Claude settings is not an array.");
  }
  const groups = hooks.SessionStart as unknown[];

  let kept = false;
  let keptWasCanonical = false;
  let replacedOrient = false;
  let droppedDuplicate = false;
  const nextGroups: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      nextGroups.push(group);
      continue;
    }
    const nextHooks: unknown[] = [];
    let removedHere = false;
    for (const entry of group.hooks) {
      const kind = basouSessionStartKind(entry);
      if (kind === null || !isRecord(entry)) {
        nextHooks.push(entry);
        continue;
      }
      if (kind === "orient") replacedOrient = true;
      if (!kept) {
        // An `orient` entry can never pass this: its command is not `command`.
        keptWasCanonical =
          entry.type === "command" &&
          entry.command === command &&
          entry.timeout === SESSION_START_HOOK_TIMEOUT_SECONDS;
        entry.type = "command";
        entry.command = command;
        entry.timeout = SESSION_START_HOOK_TIMEOUT_SECONDS;
        kept = true;
        nextHooks.push(entry);
      } else {
        droppedDuplicate = true;
        removedHere = true;
      }
    }
    // Drop a group only when THIS removal emptied it; an empty group that was
    // already there belongs to someone else.
    if (removedHere && nextHooks.length === 0) continue;
    group.hooks = nextHooks;
    nextGroups.push(group);
  }
  hooks.SessionStart = nextGroups;

  if (!kept) {
    nextGroups.push({
      matcher: SESSION_START_HOOK_MATCHER,
      hooks: [{ type: "command", command, timeout: SESSION_START_HOOK_TIMEOUT_SECONDS }],
    });
    return { settings: root, action: "installed" };
  }
  if (replacedOrient) return { settings: root, action: "replaced" };
  return {
    settings: root,
    action: keptWasCanonical && !droppedDuplicate ? "unchanged" : "updated",
  };
}

/**
 * Remove every basou-owned SessionStart entry — `hook session-start` and the
 * hand-registered `basou orient` alike, since install treats both as basou's.
 * A group emptied by the removal is dropped; a now-empty `hooks.SessionStart`
 * / `hooks` container is deleted. Foreign hooks and other keys are preserved.
 */
export function removeClaudeSessionStartHook(settings: unknown): ClaudeSessionStartHookRemoval {
  const root = cloneSettings(settings);
  if (!isRecord(root.hooks) || !Array.isArray(root.hooks.SessionStart)) {
    return { settings: root, action: "absent" };
  }
  const hooks = root.hooks as Record<string, unknown>;

  let removed = false;
  const nextGroups: unknown[] = [];
  for (const group of hooks.SessionStart as unknown[]) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      nextGroups.push(group);
      continue;
    }
    const keptHooks = group.hooks.filter((entry) => basouSessionStartKind(entry) === null);
    if (keptHooks.length === group.hooks.length) {
      nextGroups.push(group);
    } else {
      removed = true;
      if (keptHooks.length > 0) {
        group.hooks = keptHooks;
        nextGroups.push(group);
      }
    }
  }
  if (!removed) return { settings: root, action: "absent" };

  if (nextGroups.length === 0) {
    delete hooks.SessionStart;
  } else {
    hooks.SessionStart = nextGroups;
  }
  if (Object.keys(hooks).length === 0) delete root.hooks;
  return { settings: root, action: "removed" };
}

/** The first basou-owned SessionStart entry in Claude Code's settings. */
export type ClaudeSessionStartHookLocation = {
  command: string;
  kind: ClaudeSessionStartHookKind;
  /** The matcher of the group it sits in (undefined = fires on every source). */
  matcher: string | undefined;
};

/** Return the installed basou SessionStart entry, or null if none is registered. */
export function findClaudeSessionStartHook(
  settings: unknown,
): ClaudeSessionStartHookLocation | null {
  if (
    !isRecord(settings) ||
    !isRecord(settings.hooks) ||
    !Array.isArray(settings.hooks.SessionStart)
  ) {
    return null;
  }
  for (const group of settings.hooks.SessionStart) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const entry of group.hooks) {
      const kind = basouSessionStartKind(entry);
      if (kind === null || !isRecord(entry) || typeof entry.command !== "string") continue;
      return {
        command: entry.command,
        kind,
        matcher: typeof group.matcher === "string" ? group.matcher : undefined,
      };
    }
  }
  return null;
}

/**
 * SessionStart commands that run `basou orient` inside something longer — a
 * `cd` first, a `&&` chain — and were therefore NOT recognized as basou's (see
 * {@link isBasouOrientSessionStartCommand}). Install leaves them exactly as
 * they are; this exists so it can say that the position may now arrive twice,
 * instead of leaving the operator to discover it in their context window.
 */
export function findUnrecognizedOrientSessionStart(settings: unknown): string[] {
  if (
    !isRecord(settings) ||
    !isRecord(settings.hooks) ||
    !Array.isArray(settings.hooks.SessionStart)
  ) {
    return [];
  }
  const found: string[] = [];
  for (const group of settings.hooks.SessionStart) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const entry of group.hooks) {
      if (!isRecord(entry) || typeof entry.command !== "string") continue;
      if (basouSessionStartKind(entry) !== null) continue;
      if (MENTIONS_BASOU_ORIENT.test(entry.command)) found.push(entry.command);
    }
  }
  return found;
}
