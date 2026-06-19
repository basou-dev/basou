import { resolveBasouRepositoryRoot } from "@basou/core";

/**
 * Resolve the repository root for a CLI command with the workspace-view
 * fallback, shared by `orient` and `refresh` so they behave identically: a
 * git-untracked view dir that symlinks its planning repo redirects to that repo
 * (with a note on stderr), and a genuine non-git dir reports a command-specific
 * "run git init" message.
 */
export async function resolveBasouRootForCommand(
  cwd: string,
  commandName: string,
): Promise<string> {
  try {
    return await resolveBasouRepositoryRoot(cwd, {
      onRedirect: ({ via, root }) =>
        console.error(`Resolved workspace view to ${root} (via ${via}).`),
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        `Not a git repository. Run 'git init' first, then re-run 'basou ${commandName}'.`,
        { cause: error },
      );
    }
    throw error;
  }
}
