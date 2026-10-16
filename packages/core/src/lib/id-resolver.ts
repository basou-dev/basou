import type { BasouPaths } from "../storage/basou-dir.js";
import { SessionNotADirectoryError } from "../storage/session-dir.js";
import { enumerateSessionEntries } from "../storage/sessions.js";
import { enumerateArchivedTaskIds, enumerateTaskIds } from "../storage/tasks.js";

/**
 * Resolve a possibly-truncated session id prefix to a full session id by
 * scanning `<paths.sessions>/`. Existing message contract (carried over
 * from `packages/cli/src/commands/session.ts`) is
 * preserved exactly so callers that grep stderr keep working:
 *
 *   - `"Session id is empty"`
 *   - `"Session not found: <input>"`
 *   - `"Ambiguous session id '<input>': matched <N> sessions. Disambiguate
 *      with a longer prefix."`
 *
 * An entry named as a session id that is not a directory (a symlink, a file)
 * is matched too, so a prefix it shares with a session is ambiguous. When it
 * is the one match, the call throws {@link SessionNotADirectoryError}
 * (`"Session <id> is not a directory; a symlink or a file there is not
 * followed"`), with the `kind` the listing saw, unless
 * `options.allowNotDirectory` is set — `basou verify`, which reports the entry
 * instead of reading it, sets it.
 */
export async function resolveSessionId(
  paths: BasouPaths,
  input: string,
  options: { allowNotDirectory?: boolean } = {},
): Promise<string> {
  return resolveIdInternal(paths, input, "session", options);
}

/**
 * Resolve a possibly-truncated task id prefix to a full task id by scanning
 * `<paths.tasks>/`. Mirrors {@link resolveSessionId} with the noun changed
 * to `task` in every error message.
 *
 * `options.includeArchived` extends the scan to `<paths.tasks>/archive/` so
 * read-only commands (e.g. `basou task show`) can address tasks that were
 * archived by `basou task archive`. Defaults to `false` so destructive flows
 * (status change, edit, delete, archive itself) cannot operate on archived
 * tasks accidentally.
 */
export async function resolveTaskId(
  paths: BasouPaths,
  input: string,
  options: { includeArchived?: boolean } = {},
): Promise<string> {
  return resolveIdInternal(paths, input, "task", options);
}

type IdKind = "session" | "task";

type KindConfig = {
  prefix: string;
  noun: string;
  nounPlural: string;
  capNoun: string;
  /**
   * The ids, the entries named as one that are not directories, and which of
   * those are symlinks.
   */
  enumerate: (
    paths: BasouPaths,
  ) => Promise<{ ids: string[]; notDirectories: string[]; symlinks: string[] }>;
};

const KIND_CONFIG: Record<IdKind, KindConfig> = {
  session: {
    prefix: "ses_",
    noun: "session",
    nounPlural: "sessions",
    capNoun: "Session",
    enumerate: async (paths) => {
      const { dirs, notDirectories, symlinks } = await enumerateSessionEntries(paths);
      return { ids: dirs, notDirectories, symlinks };
    },
  },
  task: {
    prefix: "task_",
    noun: "task",
    nounPlural: "tasks",
    capNoun: "Task",
    enumerate: async (paths) => ({
      ids: await enumerateTaskIds(paths),
      notDirectories: [],
      symlinks: [],
    }),
  },
};

async function resolveIdInternal(
  paths: BasouPaths,
  input: string,
  kind: IdKind,
  options: { includeArchived?: boolean; allowNotDirectory?: boolean } = {},
): Promise<string> {
  const cfg = KIND_CONFIG[kind];
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error(`${cfg.capNoun} id is empty`);
  }
  const normalized = trimmed.startsWith(cfg.prefix) ? trimmed : `${cfg.prefix}${trimmed}`;
  if (normalized.length <= cfg.prefix.length) {
    throw new Error(`${cfg.capNoun} not found: ${input}`);
  }
  const { ids: primary, notDirectories, symlinks } = await cfg.enumerate(paths);
  // Merge in archived task ids when the caller opts in. Dedupe via a Set so
  // a single id appearing in both surfaces (shouldn't happen but defend
  // anyway) does not falsely register as ambiguous.
  const merged = new Set<string>(primary);
  if (kind === "task" && options.includeArchived === true) {
    for (const id of await enumerateArchivedTaskIds(paths)) {
      merged.add(id);
    }
  }
  // An entry that is not a directory is matched too, so it is reported for
  // what it is instead of "not found", and a prefix it shares is ambiguous.
  for (const id of notDirectories) merged.add(id);
  if (merged.size === 0) {
    throw new Error(`${cfg.capNoun} not found: ${input}`);
  }
  const matches = [...merged].filter((e) => e.startsWith(normalized));
  if (matches.length === 0) {
    throw new Error(`${cfg.capNoun} not found: ${input}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ${cfg.noun} id '${input}': matched ${matches.length} ${cfg.nounPlural}. Disambiguate with a longer prefix.`,
    );
  }
  const match = matches[0] as string;
  // Only a session listing reports such an entry; a task listing has none.
  if (notDirectories.includes(match) && options.allowNotDirectory !== true) {
    throw new SessionNotADirectoryError(
      match,
      symlinks.includes(match) ? "symlink" : "not_a_directory",
    );
  }
  return match;
}
