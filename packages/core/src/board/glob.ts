/**
 * Glob matching for the `include` and `exclude` of a board measure, ported
 * from git's own matching of a `:(glob)` pathspec (`match_pathspec_item`,
 * `git_fnmatch` and `wildmatch` with `WM_PATHNAME`), so a pattern means what
 * it means to git:
 *
 * - A pattern first matches literally, as a path or as a directory a path is
 *   under (`docs` and `docs/` match `docs/a.md`; `app/[slug]/page.tsx`
 *   matches that file whatever `[slug]` means as a class).
 * - Then, when it has a wildcard (`*`, `?`, `[` or `\`), the whole path must
 *   match it: `*` and `?` never match `/`, `**` matches across directories
 *   where it stands for whole segments, `[...]` is a byte class (`!` or `^`
 *   negates; `[:alpha:]` and the other POSIX classes are ASCII), and `\`
 *   escapes the next character.
 * - Matching is by byte, as git's is: paths and patterns are compared as
 *   their UTF-8 bytes, so `?` is one byte and a path that is not valid UTF-8
 *   still matches as written.
 *
 * The measures match the file list themselves rather than handing patterns
 * to git: `git ls-tree` refuses the magic, and `git ls-files` drops an
 * exclude that starts with `**\/` once an include names a directory.
 */
export type GlobMatcher = (path: string) => boolean;

/** A string with one character per byte of the UTF-8 encoding of `s`. */
export function toBytes(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

/** The text a byte string spells, with invalid UTF-8 shown as U+FFFD. */
export function fromBytes(bytes: string): string {
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/**
 * A path or pattern with `.` segments and repeated slashes removed, as git
 * normalizes a pathspec; a trailing slash is kept.
 */
export function normalizePathspec(pattern: string): string {
  const trailing = pattern.endsWith("/");
  const kept = pattern.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (kept.length === 0) return "";
  return trailing ? `${kept.join("/")}/` : kept.join("/");
}

const SPECIAL = new Set([0x2a, 0x3f, 0x5b, 0x5c]); // * ? [ \

/** The length of the part of a pattern before its first wildcard or backslash. */
export function literalLength(p: string): number {
  for (let i = 0; i < p.length; i++) if (SPECIAL.has(p.charCodeAt(i))) return i;
  return p.length;
}

/** Compile a pattern, as a declaration writes it, into a matcher of byte-string paths. */
export function compileGlob(pattern: string): GlobMatcher {
  const p = normalizePathspec(toBytes(pattern));
  const prefix = literalLength(p);
  return (name) => {
    if (p === "") return true;
    if (name === p) return true;
    if (p.length < name.length && name.startsWith(p)) {
      if (p.endsWith("/") || name[p.length] === "/") return true;
    }
    if (prefix === p.length) return false;
    if (name.slice(0, prefix) !== p.slice(0, prefix)) return false;
    return wildmatch(p.slice(prefix), name.slice(prefix)) === MATCH;
  };
}

/**
 * Whether a pattern, as a declaration writes it, may match a path under the
 * directory `dir` (a byte string without a trailing '/'; "" for the root).
 * Used when git could not list `dir`: what is under it is not known, so a
 * pattern that could reach in cannot be counted. Errs towards true.
 */
export function mayMatchUnder(pattern: string, dir: string): boolean {
  if (dir === "") return true;
  const p = normalizePathspec(toBytes(pattern)).replace(/\/$/, "");
  if (p === "") return true;
  // As a literal path, a pattern takes in what is under it.
  if (dir === p || dir.startsWith(`${p}/`) || p.startsWith(`${dir}/`)) return true;
  if (literalLength(p) === p.length) return false;
  // An escape may stand for a '/': do not split on a guess.
  if (p.includes("\\")) return true;
  const patternSegments = p.split("/");
  const dirSegments = dir.split("/");
  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i] as string;
    if (segment === "**") return true; // crosses any number of directories
    if (i >= dirSegments.length) return true; // the rest may match under `dir`
    if (wildmatch(segment, dirSegments[i] as string) !== MATCH) return false;
  }
  // The pattern ends at `dir` or above it, so no path under `dir` matches.
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

const MATCH = 0;
const NOMATCH = 1;
const ABORT_ALL = -1;
const ABORT_TO_STARSTAR = -2;

const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;
const isLower = (c: number) => c >= 0x61 && c <= 0x7a;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number) => isUpper(c) || isLower(c);
const isAlnum = (c: number) => isAlpha(c) || isDigit(c);
const isGraph = (c: number) => c >= 0x21 && c <= 0x7e;

const POSIX_CLASSES: Record<string, (c: number) => boolean> = {
  alnum: isAlnum,
  alpha: isAlpha,
  blank: (c) => c === 0x20 || c === 0x09,
  cntrl: (c) => c < 0x20 || c === 0x7f,
  digit: isDigit,
  graph: isGraph,
  lower: isLower,
  print: (c) => c >= 0x20 && c <= 0x7e,
  punct: (c) => isGraph(c) && !isAlnum(c),
  space: (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d),
  upper: isUpper,
  xdigit: (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66),
};

/** git's `wildmatch` with `WM_PATHNAME`, over byte strings: 0 when `text` matches. */
export function wildmatch(pattern: string, text: string): number {
  return dowild(pattern, 0, text, 0);
}

const SLASH = 0x2f;

// A port of git's dowild(). Indexes stand for the C pointers, and reading
// past the end gives 0, as the terminating NUL does.
function dowild(pat: string, pStart: number, text: string, tStart: number): number {
  const at = (s: string, i: number): number => (i < s.length ? s.charCodeAt(i) : 0);
  let p = pStart;
  let t = tStart;
  for (; at(pat, p) !== 0; t++, p++) {
    let pCh = at(pat, p);
    let tCh = at(text, t);
    if (tCh === 0 && pCh !== 0x2a) return ABORT_ALL;
    if (pCh === 0x5c) {
      // '\': the next character, literally.
      pCh = at(pat, ++p);
      if (tCh !== pCh) return NOMATCH;
      continue;
    }
    if (pCh === 0x3f) {
      // '?': anything but '/'.
      if (tCh === SLASH) return NOMATCH;
      continue;
    }
    if (pCh === 0x2a) {
      // '*' and '**'.
      let matchSlash = false;
      if (at(pat, ++p) === 0x2a) {
        const prev = p - 2;
        while (at(pat, ++p) === 0x2a) {}
        const next = at(pat, p);
        if (
          (prev < pStart || at(pat, prev) === SLASH) &&
          (next === 0 || next === SLASH || (next === 0x5c && at(pat, p + 1) === SLASH))
        ) {
          if (next === SLASH && dowild(pat, p + 1, text, t) === MATCH) return MATCH;
          matchSlash = true;
        }
      }
      if (at(pat, p) === 0) {
        if (!matchSlash && text.indexOf("/", t) !== -1) return NOMATCH;
        return MATCH;
      }
      if (!matchSlash && at(pat, p) === SLASH) {
        const slash = text.indexOf("/", t);
        if (slash === -1) return NOMATCH;
        t = slash; // the slash is consumed by the loop
        continue;
      }
      for (;;) {
        if (tCh === 0) break;
        const literal = at(pat, p);
        if (!SPECIAL.has(literal)) {
          for (;;) {
            tCh = at(text, t);
            if (tCh === 0 || (!matchSlash && tCh === SLASH) || tCh === literal) break;
            t++;
          }
          if (tCh !== literal) return matchSlash ? ABORT_ALL : ABORT_TO_STARSTAR;
        }
        const matched = dowild(pat, p, text, t);
        if (matched !== NOMATCH) {
          if (!matchSlash || matched !== ABORT_TO_STARSTAR) return matched;
        } else if (!matchSlash && tCh === SLASH) {
          return ABORT_TO_STARSTAR;
        }
        tCh = at(text, ++t);
      }
      return ABORT_ALL;
    }
    if (pCh === 0x5b) {
      // '[...]'
      pCh = at(pat, ++p);
      if (pCh === 0x5e) pCh = 0x21; // '^' negates as '!' does
      const negated = pCh === 0x21;
      if (negated) pCh = at(pat, ++p);
      let prevCh = 0;
      let matched = false;
      for (;;) {
        if (pCh === 0) return ABORT_ALL;
        if (pCh === 0x5c) {
          pCh = at(pat, ++p);
          if (pCh === 0) return ABORT_ALL;
          if (tCh === pCh) matched = true;
        } else if (
          pCh === 0x2d &&
          prevCh !== 0 &&
          at(pat, p + 1) !== 0 &&
          at(pat, p + 1) !== 0x5d
        ) {
          pCh = at(pat, ++p);
          if (pCh === 0x5c) {
            pCh = at(pat, ++p);
            if (pCh === 0) return ABORT_ALL;
          }
          if (tCh <= pCh && tCh >= prevCh) matched = true;
          pCh = 0; // so that prevCh becomes 0
        } else if (pCh === 0x5b && at(pat, p + 1) === 0x3a) {
          const s = p + 2;
          p = s;
          while (at(pat, p) !== 0 && at(pat, p) !== 0x5d) p++;
          if (at(pat, p) === 0) return ABORT_ALL;
          const len = p - s - 1;
          if (len < 0 || at(pat, p - 1) !== 0x3a) {
            // No ":]": a plain '[' in the set.
            p = s - 2;
            pCh = 0x5b;
            if (tCh === pCh) matched = true;
          } else {
            const test = POSIX_CLASSES[pat.slice(s, s + len)];
            if (test === undefined) return ABORT_ALL;
            if (test(tCh)) matched = true;
            pCh = 0; // so that prevCh becomes 0
          }
        } else if (tCh === pCh) {
          matched = true;
        }
        prevCh = pCh;
        pCh = at(pat, ++p);
        if (pCh === 0x5d) break;
      }
      if (matched === negated || tCh === SLASH) return NOMATCH;
      continue;
    }
    if (tCh !== pCh) return NOMATCH;
  }
  return t < text.length ? NOMATCH : MATCH;
}
