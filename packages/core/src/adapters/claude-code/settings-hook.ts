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
 * How basou's CLI appears at the start of a hook command: the bare `basou`
 * alias, or `node <entry>` with the entry quoted or not. The entry must END in
 * `@basou/cli/dist/index.js` or `packages/cli/dist/index.js` as a whole path
 * component, so another monorepo's own `packages/cli/dist/index.js` would also
 * pass, but `subpackages/...` or `some-cli/...` do not. (Stricter than the Stop
 * recognizer, which has no component boundary: an entry recognized here is
 * rewritten wholesale, so the bar for claiming it is higher.)
 */
const ENTRY = String.raw`(?:[^\s'"]*/)?(?:@basou|packages)/cli/dist/index\.js`;
const INVOCATION = String.raw`(?:basou|node[ \t]+(?:'(?:[^']*/)?(?:@basou|packages)/cli/dist/index\.js'|"(?:[^"]*/)?(?:@basou|packages)/cli/dist/index\.js"|${ENTRY}))`;
/** The optional fail-open wrapper basou's own commands carry. */
const WRAPPER = String.raw`(?:[ \t]+2>[ \t]*/dev/null)?(?:[ \t]*\|\|[ \t]*true)?`;

/**
 * Both of basou's SessionStart shapes are recognized ONLY as the whole command.
 * A recognized entry is rewritten wholesale, so a match inside
 * `cd ~/work && basou orient` — or `cd ~/work && basou hook session-start` —
 * would silently delete the `cd` somebody wrote. Horizontal whitespace only
 * (`[ \t]`): a newline is a second command, not a separator.
 *
 * `orient` takes NO flags here. The reference documented `basou orient` bare;
 * a flag changes what the hook does (`--quiet` writes the file and prints
 * nothing, so that session never received a position; `--refresh` imports
 * first), and rewriting it into `hook session-start` would change the
 * behaviour while claiming to keep it.
 */
const CLAUDE_SESSION_START = new RegExp(
  String.raw`^[ \t]*${INVOCATION}[ \t]+hook[ \t]+session-start${WRAPPER}[ \t]*$`,
);
const CLAUDE_ORIENT_SESSION_START = new RegExp(
  String.raw`^[ \t]*${INVOCATION}[ \t]+orient${WRAPPER}[ \t]*$`,
);

/** Whether a command is basou's `hook session-start`, exactly as basou writes it. */
export function isClaudeSessionStartHookCommand(command: string): boolean {
  return CLAUDE_SESSION_START.test(command);
}

/**
 * Whether a command is the documented hand-registered `basou orient` — basou's
 * own reference told Claude Code users to register exactly this before
 * `basou hook install` could, so an install that ignored it would put the
 * position into every session twice. It counts as basou's ONLY inside
 * `hooks.SessionStart`; anywhere else it is somebody's script.
 */
export function isBasouOrientSessionStartCommand(command: string): boolean {
  return CLAUDE_ORIENT_SESSION_START.test(command);
}

/** Which of basou's two SessionStart forms a command is, if either. */
export type ClaudeSessionStartHookKind = "session-start" | "orient";

function basouSessionStartKind(entry: unknown): ClaudeSessionStartHookKind | null {
  if (!isRecord(entry) || typeof entry.command !== "string") return null;
  if (isClaudeSessionStartHookCommand(entry.command)) return "session-start";
  if (isBasouOrientSessionStartCommand(entry.command)) return "orient";
  return null;
}

/**
 * Claude Code treats an absent matcher, `""` and `"*"` alike: every source.
 * Two groups are the same firing condition only when their matchers are.
 */
function matcherKey(group: Record<string, unknown>): string {
  const m = group.matcher;
  return m === undefined || m === "" || m === "*" ? "*" : String(m);
}

export type ClaudeSessionStartHookUpsert = {
  settings: ClaudeSettings;
  /**
   * `installed` = a new group was appended; `updated` = an existing
   * `hook session-start` entry was rewritten or a duplicate removed;
   * `replaced` = a hand-registered `basou orient` was rewritten into
   * `hook session-start`; `unchanged` = already canonical, nothing touched.
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
 * - EVERY basou entry — `hook session-start`, or the hand-registered
 *   `basou orient` — is rewritten IN PLACE to the canonical command + timeout.
 *   Its group's matcher is left as it is: the matcher is when the hook fires,
 *   and the person who wrote it may have chosen it. Only a new install brings
 *   basou's own matcher, in a group of its own. Same rule as the Codex twin.
 * - A later entry is removed as a duplicate only when an earlier one fires
 *   under the SAME matcher. Entries under different matchers are kept even if
 *   they overlap: collapsing them would silently narrow when the hook fires
 *   (`startup` and `resume|clear` are not duplicates). Overlap that survives is
 *   reported by {@link findClaudeSessionStartHooks}, not resolved by guessing.
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

  let found = false;
  let changed = false;
  let replacedOrient = false;
  const keptUnder = new Set<string>();
  const nextGroups: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      nextGroups.push(group);
      continue;
    }
    const key = matcherKey(group);
    const nextHooks: unknown[] = [];
    let removedHere = false;
    for (const entry of group.hooks) {
      const kind = basouSessionStartKind(entry);
      if (kind === null || !isRecord(entry)) {
        nextHooks.push(entry);
        continue;
      }
      found = true;
      if (kind === "orient") replacedOrient = true;
      if (keptUnder.has(key)) {
        // Same firing condition as an entry already kept: a true duplicate.
        changed = true;
        removedHere = true;
        continue;
      }
      if (
        entry.type !== "command" ||
        entry.command !== command ||
        entry.timeout !== SESSION_START_HOOK_TIMEOUT_SECONDS
      ) {
        changed = true;
      }
      entry.type = "command";
      entry.command = command;
      entry.timeout = SESSION_START_HOOK_TIMEOUT_SECONDS;
      keptUnder.add(key);
      nextHooks.push(entry);
    }
    // Drop a group only when THIS removal emptied it; an empty group that was
    // already there belongs to someone else.
    if (removedHere && nextHooks.length === 0) continue;
    group.hooks = nextHooks;
    nextGroups.push(group);
  }
  hooks.SessionStart = nextGroups;

  if (!found) {
    nextGroups.push({
      matcher: SESSION_START_HOOK_MATCHER,
      hooks: [{ type: "command", command, timeout: SESSION_START_HOOK_TIMEOUT_SECONDS }],
    });
    return { settings: root, action: "installed" };
  }
  if (replacedOrient) return { settings: root, action: "replaced" };
  return { settings: root, action: changed ? "updated" : "unchanged" };
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

/** One basou-owned SessionStart entry in Claude Code's settings. */
export type ClaudeSessionStartHookLocation = {
  command: string;
  kind: ClaudeSessionStartHookKind;
  /** The matcher of the group it sits in (undefined = fires on every source). */
  matcher: string | undefined;
};

/**
 * Every basou-owned SessionStart entry, in file order. More than one survives
 * an install only under different matchers — which is exactly the case a
 * reader needs to see, since overlapping matchers put the position in twice.
 */
export function findClaudeSessionStartHooks(settings: unknown): ClaudeSessionStartHookLocation[] {
  const found: ClaudeSessionStartHookLocation[] = [];
  if (!isRecord(settings) || !isRecord(settings.hooks)) return found;
  const groups = settings.hooks.SessionStart;
  if (!Array.isArray(groups)) return found;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const entry of group.hooks) {
      const kind = basouSessionStartKind(entry);
      if (kind === null || !isRecord(entry) || typeof entry.command !== "string") continue;
      found.push({
        command: entry.command,
        kind,
        matcher: typeof group.matcher === "string" ? group.matcher : undefined,
      });
    }
  }
  return found;
}

/** Whether `hooks.SessionStart` exists but cannot be read as a list of groups. */
export function isClaudeSessionStartMalformed(settings: unknown): boolean {
  return (
    isRecord(settings) &&
    isRecord(settings.hooks) &&
    settings.hooks.SessionStart !== undefined &&
    !Array.isArray(settings.hooks.SessionStart)
  );
}

/**
 * What a SessionStart command that runs basou but is NOT one of the two
 * recognized shapes appears to run: `orient` or `hook session-start`, inside a
 * longer command (a `cd` first, an `&&` chain, node options, `npx`). Install
 * leaves those exactly as written; this lets it and `status` say so.
 */
export type ClaudeUnrecognizedSessionStart = {
  command: string;
  runs: ClaudeSessionStartHookKind;
};

/**
 * A heuristic, not a shell parser: basou's CLI run as a WORD (not the tail of
 * `notbasou`), through the alias, `node [options] <entry>` or
 * `npx [-y] @basou/cli`, followed by `orient` or `hook session-start` as a
 * whole word (not `orient-foo`). A match inside a quoted string is skipped —
 * `echo 'run basou orient later'` runs nothing.
 */
const RUNS_BASOU = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:basou|node(?:[ \t]+-[^\s]+)*[ \t]+(?:'[^']*(?:@basou|packages)/cli/dist/index\.js'|"[^"]*(?:@basou|packages)/cli/dist/index\.js"|${ENTRY})|npx(?:[ \t]+-y)?[ \t]+@basou/cli)[ \t]+(orient|hook[ \t]+session-start)(?=$|[\s;&|)])`,
  "g",
);

function isInsideQuotes(text: string, index: number): boolean {
  let single = false;
  let double = false;
  for (let i = 0; i < index; i++) {
    const c = text[i];
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
  }
  return single || double;
}

export function findUnrecognizedSessionStart(settings: unknown): ClaudeUnrecognizedSessionStart[] {
  const found: ClaudeUnrecognizedSessionStart[] = [];
  if (!isRecord(settings) || !isRecord(settings.hooks)) return found;
  const groups = settings.hooks.SessionStart;
  if (!Array.isArray(groups)) return found;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const entry of group.hooks) {
      if (!isRecord(entry) || typeof entry.command !== "string") continue;
      if (basouSessionStartKind(entry) !== null) continue;
      const command = entry.command;
      for (const m of command.matchAll(RUNS_BASOU)) {
        // m.index is where the separator (or start) sits; the CLI word follows it.
        const at = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
        if (isInsideQuotes(command, at)) continue;
        found.push({ command, runs: m[1] === "orient" ? "orient" : "session-start" });
        break;
      }
    }
  }
  return found;
}
