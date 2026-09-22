import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER = "# Basou - default ignore";

// Recommended .gitignore block (ignore + commit). The test asserts an
// exact match against this spec string literal to detect spec drift.
const BASOU_GITIGNORE_BLOCK =
  "# Basou - default ignore\n" +
  ".basou/logs/\n" +
  ".basou/raw/\n" +
  ".basou/tmp/\n" +
  ".basou/locks/\n" +
  ".basou/status.json\n" +
  ".basou/orientation.md\n" +
  ".basou/sessions/*/events.jsonl\n" +
  ".basou/sessions/*/artifacts/\n" +
  ".basou/approvals/pending/\n" +
  ".basou/approvals/resolved/\n" +
  "\n" +
  "# Basou - default commit\n" +
  "# .basou/manifest.yaml\n" +
  "# .basou/handoff.md\n" +
  "# .basou/decisions.md\n" +
  "# .basou/tasks/\n" +
  "# .basou/sessions/*/session.yaml\n" +
  "# .basou/sessions/*/transcript.md\n" +
  "# .basou/sessions/*/changed-files.json\n";

// Local-only `.basou/` exclude (opt-in via `basou init --local-only`). The trail
// is never committed — it is personal/local state, regenerable by re-importing
// from the agents' own logs. Shares the marker line so re-running init is still
// idempotent. The test asserts an exact match to detect spec drift.
const BASOU_GITIGNORE_BLOCK_LOCAL_ONLY =
  "# Basou - default ignore\n" +
  "# Local-only: basou's trail is never committed (personal/local state,\n" +
  "# regenerable by re-importing from the agents' own logs). Recommended for\n" +
  "# monitored repos and any workspace kept out of version control.\n" +
  ".basou/\n";

export type AppendBasouGitignoreResult = {
  /** True if the block was appended (or the file was newly created). */
  readonly appended: boolean;
};

/** Options for {@link appendBasouGitignore}. */
export type AppendBasouGitignoreOptions = {
  /** Write a `.basou/` full-exclude block instead of the default ignore+commit block. */
  readonly localOnly?: boolean;
};

/**
 * Append Basou's default `.gitignore` block to `repositoryRoot/.gitignore`.
 *
 * The block contents are derived from the Basou v0.1 specification (the
 * standard ignore + commit recommendations). Callers must pass an absolute
 * path to a Git repository root.
 *
 * With `options.localOnly`, a `.basou/` full-exclude block is written instead
 * of the default ignore+commit block (the trail is kept out of version
 * control). The default (no options) is unchanged.
 *
 * Behavior:
 * - If `.gitignore` does not exist, it is created with the chosen Basou block.
 * - If a `# Basou - default ignore` marker OR a standalone `.basou/` exclude
 *   line is already present, the file is left untouched and `appended: false`
 *   is returned (idempotent across both modes).
 * - If `.gitignore` is a symlink, the link is followed and the target file
 *   is updated. Symlinks are not rejected.
 *
 * On I/O failure throws Error with a pathless message
 * (`Failed to read .gitignore` / `Failed to write .gitignore`) and the
 * original native error attached as `cause`.
 */
export async function appendBasouGitignore(
  repositoryRoot: string,
  options: AppendBasouGitignoreOptions = {},
): Promise<AppendBasouGitignoreResult> {
  const gitignorePath = join(repositoryRoot, ".gitignore");

  let body: string;
  let existed: boolean;
  try {
    body = await readFile(gitignorePath, "utf8");
    existed = true;
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") {
      body = "";
      existed = false;
    } else {
      throw new Error("Failed to read .gitignore", { cause: error });
    }
  }

  if (existed && hasBasouGitignore(body)) {
    return { appended: false };
  }

  const block =
    options.localOnly === true ? BASOU_GITIGNORE_BLOCK_LOCAL_ONLY : BASOU_GITIGNORE_BLOCK;
  const next = composeNextBody(body, block);
  try {
    await writeFile(gitignorePath, next, { encoding: "utf8" });
  } catch (error: unknown) {
    throw new Error("Failed to write .gitignore", { cause: error });
  }
  return { appended: true };
}

/** True if the file already carries a Basou block (marker) or a `.basou/` full-exclude line. */
function hasBasouGitignore(body: string): boolean {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith(MARKER)) return true;
    if (line === ".basou/" || line === "/.basou/") return true;
  }
  return false;
}

function composeNextBody(existing: string, block: string): string {
  if (existing.length === 0) return block;
  const normalized = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${normalized}\n${block}`;
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  return typeof (error as unknown as Record<string, unknown>).code === "string";
}
