import { tmpdir } from "node:os";
import { normalize, sep } from "node:path";

/**
 * Per-session scratch directories, and why a position must not list them.
 *
 * An agent tool gives each session a scratch directory under a temp root, and
 * names it after the session's own working directory — every non-alphanumeric
 * character replaced, so `~/projects/foo-workspace` becomes a directory called
 * `-Users-someone-projects-foo-workspace`. A file written there is recorded
 * like any other, and the recorded path is absolute: it is under neither the
 * session's working directory nor the home directory, so the path sanitizer
 * keeps it verbatim.
 *
 * Two consequences follow, and both are why this filter exists. Such a path
 * says nothing about where the work stands — it is a temp file that outlives
 * nothing. And it carries a WORKSPACE NAME in its directory name, so a
 * position listing one hands that name to whatever session reads the position.
 * That is the route by which one workspace's name reaches another workspace's
 * position in practice.
 *
 * The filter is on the RENDERED view only. The trail keeps every recorded path
 * exactly as it was written: what a session touched stays answerable, and only
 * the summary handed to an agent drops paths that are noise in it.
 */

/** Temp roots to treat as transient, before per-platform aliasing. */
const TEMP_ROOTS = ["/tmp", "/var/tmp"];

/**
 * A temp root and the spelling the platform also answers to. macOS resolves
 * `/tmp` and `/var/folders/...` through `/private`, and a path may be recorded
 * either way depending on whether it was resolved, so both are matched.
 */
function withPrivateAlias(root: string): string[] {
  const normalized = normalize(root);
  if (normalized.startsWith(`${sep}private${sep}`)) {
    return [normalized, normalized.slice(`${sep}private`.length)];
  }
  return [normalized, `${sep}private${normalized}`];
}

/**
 * Whether `filePath` is inside a temp root — an agent's per-session scratch
 * directory, or anything else under `/tmp`, `/var/tmp` or the platform temp
 * directory.
 *
 * Only ABSOLUTE paths qualify. A recorded path that is repo-relative or
 * `~`-prefixed has already been placed by the path sanitizer, which means it is
 * inside the workspace or the home directory and is exactly the kind of path a
 * position should report.
 */
export function isTransientToolPath(filePath: string, temp: string = tmpdir()): boolean {
  const candidate = normalize(filePath);
  if (!candidate.startsWith(sep)) return false;
  return [...TEMP_ROOTS, temp]
    .flatMap(withPrivateAlias)
    .some((root) => candidate === root || candidate.startsWith(root + sep));
}
