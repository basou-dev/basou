import { homedir as osHomedir } from "node:os";
import { basename, normalize, sep } from "node:path";

/**
 * Foreign-workspace name detection: find where a piece of text that ONE
 * workspace hands to an agent names a DIFFERENT registered workspace.
 *
 * Why this exists: basou hands a workspace's position to the session running in
 * it (Claude Code reads `.basou/orientation.md`; a Codex session receives the
 * same body through the SessionStart hook), and `basou protocol sync` renders
 * the operator's standing protocols into the user-global instructions file that
 * every project on the machine loads. Both are delivery channels whose PLUMBING
 * is already scoped — but neither inspects the CONTENT it delivers. A position
 * that mentions another workspace by name, or a standing protocol that names
 * one engagement, carries that name into a session that has no business seeing
 * it. This helper is the read-only primitive both warnings use; it never
 * rewrites or withholds the text.
 *
 * Matching is on PATHS AND DIRECTORY NAMES, never on the portfolio's display
 * labels. A label is a product name ("basou"), and a product name legitimately
 * appears throughout its own workspace's documents, so label matching reports a
 * hit on every line and is quickly ignored. A directory name is specific enough
 * to attribute: it is how the operator's own filesystem distinguishes the
 * workspaces.
 *
 * The bias is toward NOT crying wolf. Only names derived from a registered
 * workspace path count; anything derived from the scanning workspace's OWN path
 * is excluded, and a directory name too short to attribute is dropped.
 */

/**
 * Shortest directory name that may stand for a workspace. A name this short
 * ("ai", "web") is a common word that would match ordinary prose, and a false
 * warning on every run is a warning nobody reads.
 */
const MIN_TOKEN_LENGTH = 4;

/** One registered workspace whose name appears in the scanned text. */
export type ForeignWorkspaceHit = {
  /** The registered workspace root (absolute), as passed in. */
  workspacePath: string;
  /** The name spellings that actually matched, longest first. */
  tokens: string[];
  /** 1-based line numbers of the scanned text that carry one of those spellings, ascending. */
  lines: number[];
};

/**
 * Expand a leading `~` / `~/` to `home`. Registered paths arrive absolute, but
 * text under scan spells home-relative paths either way, so both are generated.
 */
function toTildePath(absPath: string, home: string): string | null {
  if (absPath === home) return "~";
  if (absPath.startsWith(home + sep)) return `~${absPath.slice(home.length)}`;
  return null;
}

/**
 * The name spellings that stand for one workspace root: its absolute path, its
 * `~`-relative path, its directory name, and — because basou's own convention
 * pairs a `-planning` master with a `-workspace` view — the sibling spelling of
 * that directory name. The sibling matters: the recorded paths that leak a
 * workspace name in practice (a scratchpad directory whose name encodes a
 * session's cwd) carry the VIEW spelling, while the portfolio registers the
 * MASTER.
 */
function nameTokensFor(workspacePath: string, home: string): string[] {
  const abs = normalize(workspacePath);
  const dir = basename(abs);
  const tokens = new Set<string>([abs]);
  const tilde = toTildePath(abs, home);
  if (tilde !== null) tokens.add(tilde);
  if (dir.length >= MIN_TOKEN_LENGTH) {
    tokens.add(dir);
    const paired = /^(.+)-(planning|workspace)$/.exec(dir);
    if (paired !== null) {
      tokens.add(`${paired[1]}-planning`);
      tokens.add(`${paired[1]}-workspace`);
    }
  }
  return [...tokens].filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

/**
 * Report the registered workspaces named in `text`, excluding the one doing the
 * scanning.
 *
 * - `workspacePaths` are the registered workspace roots (absolute; the caller
 *   reads them from the portfolio registry).
 * - `selfPath` is the workspace whose text this is. Every spelling derived from
 *   it is excluded, so a workspace naming ITSELF — which its position does on
 *   nearly every line — never reports. Omit it (a user-global text such as the
 *   standing-protocol block belongs to no single workspace) and every
 *   registered workspace counts as foreign.
 *
 * Matching is a case-sensitive substring test per line, so a name embedded in a
 * longer string — an encoded path, a URL — is still found. Returns one entry per
 * named workspace, in the order the paths were given; an empty array means
 * nothing was found.
 */
export function scanForeignWorkspaceNames(input: {
  text: string;
  workspacePaths: readonly string[];
  selfPath?: string | undefined;
  homedir?: string;
}): ForeignWorkspaceHit[] {
  if (input.text.length === 0 || input.workspacePaths.length === 0) return [];

  const home = input.homedir ?? osHomedir();
  const own =
    input.selfPath === undefined ? new Set<string>() : new Set(nameTokensFor(input.selfPath, home));

  const lines = input.text.split("\n");
  const hits: ForeignWorkspaceHit[] = [];

  for (const workspacePath of input.workspacePaths) {
    const tokens = nameTokensFor(workspacePath, home).filter((t) => !own.has(t));
    if (tokens.length === 0) continue;

    const matched = new Set<string>();
    const matchedLines: number[] = [];
    for (const [index, line] of lines.entries()) {
      let lineMatched = false;
      for (const token of tokens) {
        if (line.includes(token)) {
          matched.add(token);
          lineMatched = true;
        }
      }
      if (lineMatched) matchedLines.push(index + 1);
    }
    if (matchedLines.length === 0) continue;

    hits.push({
      workspacePath,
      tokens: [...matched].sort((a, b) => b.length - a.length || a.localeCompare(b)),
      lines: matchedLines,
    });
  }

  return hits;
}
