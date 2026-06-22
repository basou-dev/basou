/**
 * The single lexical relative-path normalizer shared by every `basou project`
 * command (roster drift, source-root reconcile, archive/rename matching, view +
 * symlink + preset dedup). It produces a canonical COMPARISON key — it is the
 * answer to "do these two declared paths denote the same location?", not a
 * validator (see `SOURCE_ROOT_PATTERN` in the manifest schema) and not an identity
 * resolver (see `realpathSync` for on-disk identity).
 *
 * It is string-pure (NO filesystem access): two paths must compare equal from
 * their spelling alone, so the manifest can be reasoned about without touching
 * disk. It:
 * - trims surrounding whitespace (declared paths carry no leading/trailing space);
 * - drops empty segments (collapsing `//` and a trailing `/`) and `.` segments;
 * - resolves a `..` against the preceding NORMAL segment, and otherwise keeps it
 *   (a relative path may ascend: `../b`, `../../b` are preserved);
 * - preserves whitespace INSIDE a segment (a directory may legitimately be named
 *   with spaces — `../my repo` stays `../my repo`), never collapsing it; and
 * - yields `.` for an empty / all-dot result.
 *
 * So `../b`, `../b/`, `../b/.`, `./../b`, and `a/../../b` all canonicalize to
 * `../b`, while `x/..` and `a/b/../..` canonicalize to `.`. Absolute input (which
 * declared paths never are) is normalized defensively, `..` above the root being
 * dropped.
 */
export function normalizeRelativePath(p: string): string {
  const trimmed = p.trim();
  // Absolute detection is on the trimmed string, so a malformed leading-
  // whitespace-then-slash input (`   /a`) canonicalizes as absolute rather than
  // mis-resolving. This is defensive only: a declared/validated path is always
  // relative (SOURCE_ROOT_PATTERN forbids both leading whitespace and a leading
  // slash), so this branch is unreachable from any manifest value.
  const absolute = trimmed.startsWith("/");
  const out: string[] = [];
  for (const seg of trimmed.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const top = out[out.length - 1];
      if (top !== undefined && top !== "..") {
        out.pop(); // resolve against a preceding normal segment
      } else if (!absolute) {
        out.push(".."); // a relative path may ascend; an absolute one cannot pass root
      }
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (absolute) return `/${joined}`;
  return joined.length === 0 ? "." : joined;
}
