import { dirname } from "node:path";
import { assertObservationsDirSafe, type BasouPaths, displayPath } from "@basou/core";

/**
 * Say on stderr, in one line, that `.basou/tmp` or `.basou/tmp/observations`
 * is refused (a symlink, a file, or an entry that cannot be inspected).
 * Silent when observations can be used there, an absent directory included.
 *
 * Nothing else says so. The hooks that write observations have no reader for
 * stderr and stay silent, and an import treats a refused directory as it
 * treats a session that was never observed, so the files a session changed
 * through the shell drop out of its `related_files` without a sign. The line
 * names the workspace by path: one `refresh --portfolio` run checks every
 * registered workspace in a row.
 */
export async function warnIfObservationsRefused(paths: BasouPaths): Promise<void> {
  try {
    await assertObservationsDirSafe(paths.observations);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `basou: ${reason} (in ${displayPath(dirname(paths.root))}). ` +
        "The files a session changes through the shell are not observed there, " +
        "so a session imported now records only the files its transcript names.",
    );
  }
}
