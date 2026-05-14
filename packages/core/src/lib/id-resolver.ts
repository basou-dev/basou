import type { BasouPaths } from "../storage/basou-dir.js";
import { enumerateSessionDirs } from "../storage/sessions.js";
import { enumerateTaskIds } from "../storage/tasks.js";

/**
 * Resolve a possibly-truncated session id prefix to a full session id by
 * scanning `<paths.sessions>/`. Existing message contract (carried over
 * from `packages/cli/src/commands/session.ts` 経由の Step 12 実装) is
 * preserved exactly so callers that grep stderr keep working:
 *
 *   - `"Session id is empty"`
 *   - `"Session not found: <input>"`
 *   - `"Ambiguous session id '<input>': matched <N> sessions. Disambiguate
 *      with a longer prefix."`
 */
export async function resolveSessionId(paths: BasouPaths, input: string): Promise<string> {
  return resolveIdInternal(paths, input, "session");
}

/**
 * Resolve a possibly-truncated task id prefix to a full task id by scanning
 * `<paths.tasks>/`. Mirrors {@link resolveSessionId} with the noun changed
 * to `task` in every error message.
 */
export async function resolveTaskId(paths: BasouPaths, input: string): Promise<string> {
  return resolveIdInternal(paths, input, "task");
}

type IdKind = "session" | "task";

type KindConfig = {
  prefix: string;
  noun: string;
  nounPlural: string;
  capNoun: string;
  enumerate: (paths: BasouPaths) => Promise<string[]>;
};

const KIND_CONFIG: Record<IdKind, KindConfig> = {
  session: {
    prefix: "ses_",
    noun: "session",
    nounPlural: "sessions",
    capNoun: "Session",
    enumerate: enumerateSessionDirs,
  },
  task: {
    prefix: "task_",
    noun: "task",
    nounPlural: "tasks",
    capNoun: "Task",
    enumerate: enumerateTaskIds,
  },
};

async function resolveIdInternal(paths: BasouPaths, input: string, kind: IdKind): Promise<string> {
  const cfg = KIND_CONFIG[kind];
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error(`${cfg.capNoun} id is empty`);
  }
  const normalized = trimmed.startsWith(cfg.prefix) ? trimmed : `${cfg.prefix}${trimmed}`;
  if (normalized.length <= cfg.prefix.length) {
    throw new Error(`${cfg.capNoun} not found: ${input}`);
  }
  const entries = await cfg.enumerate(paths);
  if (entries.length === 0) {
    throw new Error(`${cfg.capNoun} not found: ${input}`);
  }
  const matches = entries.filter((e) => e.startsWith(normalized));
  if (matches.length === 0) {
    throw new Error(`${cfg.capNoun} not found: ${input}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ${cfg.noun} id '${input}': matched ${matches.length} ${cfg.nounPlural}. Disambiguate with a longer prefix.`,
    );
  }
  return matches[0] as string;
}
