/**
 * The root of every error class the SDK defines. Today each of them is a
 * refusal: an id prefix that matches more than one record
 * ({@link AmbiguousIdError}), or a workspace layout the SDK does not read
 * through — no usable `.basou/` at `openWorkspace`
 * ({@link WorkspaceNotFoundError}), or a directory of the store that is a
 * symlink or not a directory ({@link StoreUnsafeError}). The last two are
 * refusals that `@basou/core` makes, carried as SDK errors. Every other error
 * propagates from `@basou/core` as-is — a malformed record (an approval file
 * that is not a valid approval, for instance), a record a newer basou wrote,
 * or an I/O failure during a read, including a failure to inspect a directory
 * of the store — and its class and message are not part of the SDK's
 * contract. So today `instanceof BasouSdkError` identifies "the SDK rejected
 * this call" rather than "the data was bad" or "the read failed". Such a
 * failure may come to be thrown as an SDK error class of its own, which
 * extends this one too, so test for the subclass you handle.
 *
 * What a caller can rely on is the class, `name` (the name of the class the
 * SDK exports, set as a string so that a build that renames classes does not
 * change it) and the fields each class documents. The message is for a person
 * to read and may be reworded at any release, so tell errors apart by class,
 * not by message. A constructor may change too: an SDK error is for the SDK to
 * throw. When an error carries a `cause`, that is for diagnosis only, and
 * extending an SDK error class is not covered. docs/spec/compatibility.md
 * states these terms.
 */
export class BasouSdkError extends Error {
  // A type-only brand, one per class, that emits nothing. It makes each SDK
  // error class nominal: TypeScript refuses a sibling class, a parent, a plain
  // `Error` or an object literal of the same shape where one class is typed.
  // Without it, adding a field to one class would break code that passes
  // another class of the same shape where the first is typed. Every SDK error
  // class declares its own brand from its first release.
  declare private readonly __basouSdkError: never;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // A consumer's subclass, which has no entry, keeps its own class name.
    this.name = SDK_ERROR_NAMES.get(new.target) ?? new.target.name;
  }
}

/**
 * `openWorkspace` was pointed at a path that is not a usable Basou workspace:
 * the `.basou/` directory is missing, is a symlink, or is otherwise not a
 * directory. The offending repository root is on {@link root}.
 */
export class WorkspaceNotFoundError extends BasouSdkError {
  declare private readonly __workspaceNotFound: never;
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
 * never creates such an entry. The SDK throws a subclass that names the store
 * — today {@link SessionStoreUnsafeError}, {@link TaskStoreUnsafeError} or
 * {@link ApprovalStoreUnsafeError}. A store the SDK comes to read may get a
 * subclass of its own, so catch this class to handle all of them. The
 * workspace's repository root is on {@link root}; the message names the
 * directory, such as `.basou/tasks is a symlink; refusing to operate` or
 * `.basou/approvals/pending exists but is not a directory`.
 *
 * Only the reads that need the store throw it, and each one checks when it
 * reads, not when the workspace is opened, so a workspace opened before the
 * entry was replaced throws it too. A read that comes to need a store it does
 * not read today throws for that store as well. A failure to inspect the
 * entry at all (a permission error, for instance) is not this error: it
 * propagates from `@basou/core` as other I/O failures do.
 */
export class StoreUnsafeError extends BasouSdkError {
  declare private readonly __storeUnsafe: never;
  readonly root: string;
  constructor(root: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.root = root;
  }
}

/**
 * The {@link StoreUnsafeError} for `.basou/sessions`, which the message names.
 * A session lookup given an id that is empty once trimmed, or `ses_` alone,
 * reads nothing and does not throw it.
 */
export class SessionStoreUnsafeError extends StoreUnsafeError {
  declare private readonly __sessionStoreUnsafe: never;
}

/**
 * The {@link StoreUnsafeError} for the task store, `.basou/tasks` or
 * `.basou/tasks/archive`, which the message names. A task lookup given an id
 * that is empty once trimmed, or `task_` alone, reads nothing and does not
 * throw it.
 */
export class TaskStoreUnsafeError extends StoreUnsafeError {
  declare private readonly __taskStoreUnsafe: never;
}

/**
 * The {@link StoreUnsafeError} for the approval store, `.basou/approvals`,
 * `.basou/approvals/pending` or `.basou/approvals/resolved`, which the message
 * names.
 */
export class ApprovalStoreUnsafeError extends StoreUnsafeError {
  declare private readonly __approvalStoreUnsafe: never;
}

/**
 * A session / task id prefix matched more than one record. The {@link input}
 * is the prefix as given; the caller should retry with a longer one. (A prefix
 * that matches nothing is NOT an error — the lookup returns `null` instead.)
 */
export class AmbiguousIdError extends BasouSdkError {
  declare private readonly __ambiguousId: never;
  readonly input: string;
  constructor(input: string, options?: { cause?: unknown }) {
    super(`Ambiguous id '${input}': matched more than one record; use a longer prefix.`, options);
    this.input = input;
  }
}

/**
 * The `name` of each SDK error class, as a string, so that a build that
 * renames classes (a minifier, or a bundler resolving a name collision) does
 * not change it. Every SDK error class has an entry.
 */
const SDK_ERROR_NAMES: ReadonlyMap<abstract new (...args: never) => BasouSdkError, string> =
  new Map<abstract new (...args: never) => BasouSdkError, string>([
    [BasouSdkError, "BasouSdkError"],
    [WorkspaceNotFoundError, "WorkspaceNotFoundError"],
    [StoreUnsafeError, "StoreUnsafeError"],
    [SessionStoreUnsafeError, "SessionStoreUnsafeError"],
    [TaskStoreUnsafeError, "TaskStoreUnsafeError"],
    [ApprovalStoreUnsafeError, "ApprovalStoreUnsafeError"],
    [AmbiguousIdError, "AmbiguousIdError"],
  ]);
