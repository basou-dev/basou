/**
 * Base class for every error by which the SDK rejects a call: an id prefix
 * that matches more than one record ({@link AmbiguousIdError}), and a
 * workspace layout it does not read through — no usable `.basou/` at
 * `openWorkspace` ({@link WorkspaceNotFoundError}), or a
 * `.basou/sessions` that is a symlink or not a directory
 * ({@link SessionStoreUnsafeError}). The last two are refusals that
 * `@basou/core` makes, carried as SDK errors. Every other error from
 * `@basou/core` propagates as-is — a malformed record (an invalid
 * `session.yaml`, for instance) or an I/O failure during a read, including a
 * failure to inspect `.basou/sessions` — so `instanceof BasouSdkError`
 * identifies "the SDK rejected this call" rather than "the data was bad" or
 * "the read failed".
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
 * A read of the workspace's sessions found `.basou/sessions` to be a symlink
 * or something other than a directory, and refused to read through it. basou
 * never creates such an entry. The workspace's repository root is on
 * {@link root}; the message is the one `@basou/core` gives,
 * `.basou/sessions is a symlink; refusing to operate` or `.basou/sessions
 * exists but is not a directory`.
 *
 * Only the reads that need the sessions throw it, and each one checks the
 * entry when it reads, not when the workspace is opened, so a workspace
 * opened before the entry was replaced throws it too. A session lookup given
 * an id that is empty once trimmed, or `ses_` alone, reads nothing and does
 * not throw it. A failure to inspect the entry at all (a permission error,
 * for instance) is not this error: it propagates from `@basou/core` as other
 * I/O failures do.
 */
export class SessionStoreUnsafeError extends BasouSdkError {
  readonly root: string;
  constructor(root: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
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
