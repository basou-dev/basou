/**
 * Base class for every error the SDK throws on its own behalf. Errors that
 * originate in `@basou/core` (e.g. a malformed `session.yaml`) propagate as-is;
 * only the SDK's own preconditions are wrapped, so `instanceof BasouSdkError`
 * identifies "the SDK rejected this call" rather than "the data was bad".
 */
export class BasouSdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * `openWorkspace` was pointed at a path that is not a usable Basou workspace:
 * the `.basou/` directory is missing, is a symlink, or is otherwise not a
 * directory. The offending repository root is on {@link root}.
 */
export class WorkspaceNotFoundError extends BasouSdkError {
  readonly root: string;
  constructor(root: string, options?: { cause?: unknown }) {
    super(
      `No Basou workspace at ${root}: expected a '.basou/' directory (run 'basou init' there first).`,
      options,
    );
    this.root = root;
  }
}

/**
 * A session / task id prefix matched more than one record. The {@link input}
 * is the prefix as given; the caller should retry with a longer one. (A prefix
 * that matches nothing is NOT an error — the lookup returns `null` instead.)
 */
export class AmbiguousIdError extends BasouSdkError {
  readonly input: string;
  constructor(input: string, options?: { cause?: unknown }) {
    super(`Ambiguous id '${input}': matched more than one record; use a longer prefix.`, options);
    this.input = input;
  }
}
