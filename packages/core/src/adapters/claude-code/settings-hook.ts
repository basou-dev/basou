/**
 * Pure transforms for registering / removing basou's Stop hook inside a parsed
 * Claude Code settings.json object. No disk or environment access: the CLI reads
 * and writes the file, parses the JSON, and passes the object here so the
 * merge/removal logic stays deterministic and unit-testable.
 *
 * settings.json holds many unrelated keys (permissions, model, other hooks);
 * these functions clone the input and touch ONLY the `hooks.Stop` entry that
 * basou owns, preserving everything else byte-for-byte through the round-trip.
 */

/** Seconds before Claude Code kills the hook process. Matches the documented orient (SessionStart) hook. */
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
