import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER = "# Basou - default ignore";

// 推奨 .gitignore ブロック（ignore + commit）。spec drift 検知のため
// テストで spec 文字列リテラルとの完全一致を assert する。
const BASOU_GITIGNORE_BLOCK =
  "# Basou - default ignore\n" +
  ".basou/logs/\n" +
  ".basou/raw/\n" +
  ".basou/tmp/\n" +
  ".basou/locks/\n" +
  ".basou/status.json\n" +
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

export type AppendBasouGitignoreResult = {
  /** True if the block was appended (or the file was newly created). */
  readonly appended: boolean;
};

/**
 * Append Basou's default `.gitignore` block to `repositoryRoot/.gitignore`.
 *
 * The block contents are derived from the Basou v0.1 specification (the
 * standard ignore + commit recommendations). Callers must pass an absolute
 * path to a Git repository root.
 *
 * Behavior:
 * - If `.gitignore` does not exist, it is created with the Basou block.
 * - If a line starting with `# Basou - default ignore` is already present,
 *   the file is left untouched and `appended: false` is returned
 *   (idempotent).
 * - If `.gitignore` is a symlink, the link is followed and the target file
 *   is updated. Symlinks are not rejected.
 *
 * On I/O failure throws Error with a pathless message
 * (`Failed to read .gitignore` / `Failed to write .gitignore`) and the
 * original native error attached as `cause`.
 */
export async function appendBasouGitignore(
  repositoryRoot: string,
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

  if (existed && hasBasouMarker(body)) {
    return { appended: false };
  }

  const next = composeNextBody(body);
  try {
    await writeFile(gitignorePath, next, { encoding: "utf8" });
  } catch (error: unknown) {
    throw new Error("Failed to write .gitignore", { cause: error });
  }
  return { appended: true };
}

function hasBasouMarker(body: string): boolean {
  for (const rawLine of body.split("\n")) {
    if (rawLine.trimEnd().startsWith(MARKER)) return true;
  }
  return false;
}

function composeNextBody(existing: string): string {
  if (existing.length === 0) return BASOU_GITIGNORE_BLOCK;
  const normalized = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${normalized}\n${BASOU_GITIGNORE_BLOCK}`;
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  return typeof (error as unknown as Record<string, unknown>).code === "string";
}
