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
 * Such a path says nothing about where the work stands: it is a temp file that
 * outlives nothing, and on a real store it can crowd out every real file in a
 * summary. That is what this filter is for — noise, not safety.
 *
 * It is NOT a containment measure, and must not be described as one. The same
 * encoded name appears in paths this filter deliberately leaves alone (an
 * agent's own per-project directory under the home directory, which the path
 * sanitizer spells with a leading `~`), so removing the temp-root ones closes
 * no route on its own. What keeps a workspace's name out of another
 * workspace's session is the registry-based scan the CLI runs over the
 * rendered text, and the hook that withholds a position on a hit.
 *
 * The filter is on the RENDERED view only. The trail keeps every recorded path
 * exactly as it was written: what a session touched stays answerable, and only
 * the summary handed to an agent drops paths that are noise in it.
 *
 * Being under a temp root is NOT on its own enough to drop a path. A workspace
 * can legitimately live under one — a checkout in `/tmp`, and every test
 * fixture that builds a workspace with `mkdtemp` — and dropping its files would
 * empty the very summary this is meant to keep useful. What identifies a scratch
 * directory is the ENCODED WORKING DIRECTORY in its name: a segment that began
 * life as an absolute path, so it starts with the separator turned into a dash
 * and carries a dash for every one after it. A directory named that way is
 * machinery, never something a person created.
 */

/** Temp roots to treat as transient, before per-platform aliasing. */
const TEMP_ROOTS = ["/tmp", "/var/tmp"];

/**
 * Dashes an encoded absolute path must carry to be recognized as one. The
 * encoding turns every separator into a dash, so even a shallow path
 * (`/home/u/x`) yields three. The floor keeps an ordinary directory that merely
 * starts with a dash from being mistaken for an encoded one.
 */
const MIN_ENCODED_DASHES = 3;

/**
 * Whether `segment` is a working directory an agent tool encoded into a single
 * directory name: it starts where the leading separator was, and carries one
 * dash per separator that followed.
 */
function isEncodedWorkingDirectory(segment: string): boolean {
  return segment.startsWith("-") && segment.split("-").length - 1 >= MIN_ENCODED_DASHES;
}

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
 * Whether `filePath` is an agent's per-session scratch path: under a temp root
 * (`/tmp`, `/var/tmp`, or the platform temp directory) AND carrying an encoded
 * working directory in one of the segments below that root.
 *
 * Only ABSOLUTE paths qualify. A recorded path that is repo-relative or
 * `~`-prefixed has already been placed by the path sanitizer, which means it is
 * inside the workspace or the home directory and is exactly the kind of path a
 * position should report.
 */
export function isTransientToolPath(filePath: string, temp: string = tmpdir()): boolean {
  const candidate = normalize(filePath);
  if (!candidate.startsWith(sep)) return false;
  const root = [...TEMP_ROOTS, temp]
    .flatMap(withPrivateAlias)
    .find((r) => candidate === r || candidate.startsWith(r + sep));
  if (root === undefined) return false;
  return candidate.slice(root.length).split(sep).some(isEncodedWorkingDirectory);
}
