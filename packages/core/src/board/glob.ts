/**
 * Glob matching for the `include` and `exclude` of a board measure, in the
 * dialect of git's `:(glob)` pathspec magic:
 *
 * - `*` matches any run of characters except `/`, and `?` one character
 *   except `/`; `[...]` is a character class (`[!...]` or `[^...]` negated)
 *   that never matches `/`.
 * - `**` matches across directories when it is a whole path segment: a
 *   leading `**\/` matches in every directory, a trailing `/**` everything
 *   inside, and `/**\/` zero or more directories. Elsewhere it is `*`.
 * - `\` escapes the next character.
 * - A pattern with no wildcard also matches every path under the directory it
 *   names (`docs` matches `docs/a.md`); a pattern with one must match the whole
 *   path (`docs/*` is only the files directly in `docs`).
 *
 * The measures match the file list themselves rather than handing the
 * patterns to git: `git ls-tree` refuses the magic, and `git ls-files` drops
 * an exclude that starts with `**\/` once an include has a directory in it.
 */
export type GlobMatcher = (path: string) => boolean;

export function compileGlob(pattern: string): GlobMatcher {
  const under = hasWildcard(normalizePattern(pattern)) ? "" : "(?:/.*)?";
  const re = new RegExp(`^${globSource(pattern)}${under}$`, "su");
  return (path) => re.test(path);
}

function hasWildcard(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "\\") i++;
    else if (p[i] === "*" || p[i] === "?" || p[i] === "[") return true;
  }
  return false;
}

/** A matcher for a list of include patterns minus a list of exclude patterns. */
export function compileGlobs(
  include: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): GlobMatcher {
  const includes = (include ?? []).map(compileGlob);
  const excludes = (exclude ?? []).map(compileGlob);
  return (path) =>
    (include === undefined || includes.some((m) => m(path))) && !excludes.some((m) => m(path));
}

// A leading "./" and repeated slashes say nothing a path in the list does not.
function normalizePattern(pattern: string): string {
  let p = pattern.replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p === ".") return "";
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

// Under the u flag only syntax characters may be escaped; `\-` is an error.
function escapeRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function globSource(pattern: string): string {
  const p = normalizePattern(pattern);
  if (p === "") return ".*";
  let out = "";
  let i = 0;
  while (i < p.length) {
    const ch = p[i] as string;
    if (ch === "\\" && i + 1 < p.length) {
      out += escapeRegex(p[i + 1] as string);
      i += 2;
      continue;
    }
    if (ch === "*") {
      let j = i;
      while (p[j] === "*") j++;
      const run = j - i;
      const atStart = i === 0 || p[i - 1] === "/";
      const atEnd = j === p.length || p[j] === "/";
      if (run >= 2 && atStart && atEnd) {
        if (j === p.length) {
          // "a/**" is everything inside a; a bare "**" is everything.
          out += i === 0 ? ".*" : ".+";
          i = j;
        } else {
          // "**/" matches zero or more whole directories.
          out += "(?:[^/]*/)*";
          i = j + 1;
        }
        continue;
      }
      out += "[^/]*";
      i = j;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      const close = classEnd(p, i);
      if (close !== -1) {
        out += classSource(p.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    out += escapeRegex(ch);
    i++;
  }
  return out;
}

// The index of the ']' that closes the class opened at `open`, or -1.
function classEnd(p: string, open: number): number {
  let i = open + 1;
  if (p[i] === "!" || p[i] === "^") i++;
  if (p[i] === "]") i++;
  while (i < p.length) {
    if (p[i] === "\\") i += 2;
    else if (p[i] === "]") return i;
    else i++;
  }
  return -1;
}

function classSource(body: string): string {
  let negate = false;
  let b = body;
  if (b.startsWith("!") || b.startsWith("^")) {
    negate = true;
    b = b.slice(1);
  }
  let out = "";
  for (let i = 0; i < b.length; i++) {
    const ch = b[i] as string;
    if (ch === "\\" && i + 1 < b.length) {
      const next = b[i + 1] as string;
      out += /[\\\]^[-]/.test(next) ? `\\${next}` : next;
      i++;
    } else if (ch === "-" && i > 0 && i < b.length - 1) {
      out += "-";
    } else {
      out += /[\\\]^[-]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  // A class never matches '/', negated or not.
  return negate ? `[^/${out}]` : `(?:(?!/)[${out}])`;
}
