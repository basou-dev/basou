/**
 * Base class for every error by which the SDK rejects a call: an id prefix
 * that matches more than one record ({@link AmbiguousIdError}), and a
 * workspace layout it does not read through — no usable `.basou/` at
 * `openWorkspace` ({@link WorkspaceNotFoundError}), or a directory of the
 * store that is a symlink or not a directory ({@link StoreUnsafeError}). The
 * last two are refusals that `@basou/core` makes, carried as SDK errors.
 * Every other error from `@basou/core` propagates as-is — a malformed record
 * (an invalid `session.yaml`, for instance) or an I/O failure during a read,
 * including a failure to inspect a directory of the store — so `instanceof
 * BasouSdkError` identifies "the SDK rejected this call" rather than "the
 * data was bad" or "the read failed".
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
 * A read found a directory of the workspace's `.basou/` store to be a symlink
 * or something other than a directory, and refused to read through it. basou
 * never creates such an entry. The SDK throws one of the subclasses, which
 * name the store: {@link SessionStoreUnsafeError}, {@link TaskStoreUnsafeError}
 * or {@link ApprovalStoreUnsafeError}; catch this class to handle all of them.
 * The workspace's repository root is on {@link root}; the message is the one
 * `@basou/core` gives, naming the directory, such as `.basou/tasks is a
 * symlink; refusing to operate` or `.basou/approvals/pending exists but is not
 * a directory`, and core's error is the cause.
 *
 * Only the reads that need the store throw it, and each one checks when it
 * reads, not when the workspace is opened, so a workspace opened before the
 * entry was replaced throws it too. A failure to inspect the entry at all (a
 * permission error, for instance) is not this error: it propagates from
 * `@basou/core` as other I/O failures do.
 */
export class StoreUnsafeError extends BasouSdkError {
  readonly root: string;
  constructor(root: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.root = root;
  }
}

/**
 * The {@link StoreUnsafeError} for `.basou/sessions`: the message is
 * `.basou/sessions is a symlink; refusing to operate` or `.basou/sessions
 * exists but is not a directory`. A session lookup given an id that is empty
 * once trimmed, or `ses_` alone, reads nothing and does not throw it.
 */
export class SessionStoreUnsafeError extends StoreUnsafeError {}

/**
 * The {@link StoreUnsafeError} for the task store, `.basou/tasks` or
 * `.basou/tasks/archive`, which the message names. A task lookup given an id
 * that is empty once trimmed, or `task_` alone, reads nothing and does not
 * throw it.
 */
export class TaskStoreUnsafeError extends StoreUnsafeError {}

/**
 * The {@link StoreUnsafeError} for the approval store, `.basou/approvals`,
 * `.basou/approvals/pending` or `.basou/approvals/resolved`, which the message
 * names.
 */
export class ApprovalStoreUnsafeError extends StoreUnsafeError {}

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
