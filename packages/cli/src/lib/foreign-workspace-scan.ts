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
 * it. This is the read-only primitive both warnings use; it never rewrites or
 * withholds the text.
 *
 * Matching is on PATHS AND DIRECTORY NAMES, never on the portfolio's display
 * labels. A label is a product name ("basou"), and a product name legitimately
 * appears throughout its own workspace's documents, so label matching reports a
 * hit on every line and is quickly ignored. A directory name is specific enough
 * to attribute: it is how the operator's own filesystem distinguishes the
 * workspaces.
 *
 * Matching is LEXICAL and case-sensitive: a plain substring test per line, with
 * no filesystem access. Two consequences the caller owns. It must canonicalize
 * the paths it passes (resolve symlinks and aliases) if it wants an aliased
 * spelling to be recognized — the CLI helper does. And a path written in a case
 * the filesystem would accept but the record does not use is not matched;
 * recorded paths preserve the case they were created with, so this costs
 * nothing in practice.
 *
 * The bias is toward NOT crying wolf. Only names derived from a registered
 * workspace path count; any spelling that also occurs inside the scanning
 * workspace's OWN names is excluded, and a directory name too short to
 * attribute is dropped.
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

/** Drop a trailing separator so `/a/b/` and `/a/b` produce the same names. */
function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -sep.length) : p;
}

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
 * How an agent tool encodes a directory path into a single directory name:
 * EVERY non-alphanumeric character becomes `-`, not just the separator. basou's
 * own Claude Code adapter derives its per-project log directory this way, and
 * the same encoding names the scratchpad directories that carry a session's cwd
 * — the paths through which a workspace name reaches a position in practice. A
 * workspace whose directory name contains `_` or `.` therefore appears in those
 * paths under a spelling its own name does not contain.
 */
function encodedSpelling(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The directory-name spellings that stand for one workspace directory. basou's
 * convention pairs a `-planning` master with a `-workspace` view, so a
 * registered master also answers to its view's name (and the other way round);
 * a solo repo answers to its own name and to the view name the convention would
 * give it. Each spelling is also emitted in its encoded form.
 */
function directoryNameSpellings(dir: string): string[] {
  const paired = /^(.+)-(planning|workspace)$/.exec(dir);
  const plain =
    paired !== null
      ? [`${paired[1]}-planning`, `${paired[1]}-workspace`]
      : [dir, `${dir}-workspace`];
  return [...plain, ...plain.map(encodedSpelling)];
}

/** Every spelling that stands for one workspace root: paths and directory names. */
function nameTokensFor(workspacePath: string, home: string): string[] {
  const abs = stripTrailingSep(normalize(workspacePath));
  const tokens = new Set<string>([abs]);
  const tilde = toTildePath(abs, home);
  if (tilde !== null) tokens.add(tilde);
  for (const name of directoryNameSpellings(basename(abs))) tokens.add(name);
  return [...tokens].filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

/**
 * Report the registered workspaces named in `text`, excluding the one doing the
 * scanning.
 *
 * - `workspacePaths` are the registered workspace roots (absolute; the caller
 *   reads them from the portfolio registry and canonicalizes them).
 * - `selfPath` is the workspace whose text this is. Any spelling that occurs
 *   inside one of its own names is excluded, so a workspace naming ITSELF —
 *   which its position does on nearly every line — never reports, and neither
 *   does a shorter registered name nested inside the self's (a solo `atlas`
 *   registered alongside `atlas-planning` would otherwise fire on every line
 *   the self's own path appears on). The cost is deliberate: a nested name is
 *   indistinguishable from the self's, and this design would rather miss it
 *   than warn on every line. Omit `selfPath` for a user-global text that
 *   belongs to no single workspace (the standing-protocol block) and every
 *   registered workspace counts.
 *
 * Returns one entry per named workspace, in the order the paths were given; an
 * empty array means nothing was found.
 */
export function scanForeignWorkspaceNames(input: {
  text: string;
  workspacePaths: readonly string[];
  selfPath?: string | undefined;
  homedir?: string;
}): ForeignWorkspaceHit[] {
  if (input.text.length === 0 || input.workspacePaths.length === 0) return [];

  const home = input.homedir ?? osHomedir();
  const own = input.selfPath === undefined ? [] : nameTokensFor(input.selfPath, home);

  const lines = input.text.split("\n");
  const hits: ForeignWorkspaceHit[] = [];

  for (const workspacePath of input.workspacePaths) {
    const tokens = nameTokensFor(workspacePath, home).filter(
      (token) => !own.some((ownToken) => ownToken.includes(token)),
    );
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
