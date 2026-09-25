import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  acquireLock,
  appendEventToExistingSession,
  assertBasouRootSafe,
  basouPaths,
  createAdHocSessionWithEvent,
  EVENT_SCHEMA_VERSION,
  type Event,
  findErrorCode,
  LOCAL_CLI_EVENT_SOURCE,
  type PrefixedId,
  readManifest,
  resolveSessionId,
  type SessionStatus,
  sanitizePath,
} from "@basou/core";
import { type Command, InvalidArgumentError } from "commander";
import {
  failedToFinalizeClassifier,
  isVerbose,
  renderCliError,
  shortSessionId,
} from "../lib/error-render.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";

// Single words that are almost certainly a mistyped subcommand rather than a
// real note body (e.g. `basou note list` expecting a listing). A body that is
// exactly one of these is refused with a hint; multi-word bodies are unaffected.
const NOTE_SUBCOMMAND_LOOKALIKES = new Set([
  "list",
  "ls",
  "show",
  "get",
  "add",
  "new",
  "edit",
  "rm",
  "remove",
  "delete",
  "help",
]);

// The note body becomes an ad-hoc session label; truncate long bodies for the
// label only (the full body is preserved in the note_added event). Mirrors the
// decision-title cap so labels stay single-column in session list / handoff.
const LABEL_BODY_MAX = 80;
const LABEL_TRUNCATE_HEAD = LABEL_BODY_MAX - 3;

export type NoteOptions = {
  session?: string;
  /** Read the note text from this file instead of the argument or stdin. */
  file?: string;
  json?: boolean;
  verbose?: boolean;
};

export type NoteContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
  /**
   * Defaults to reading process.stdin to EOF. Injectable for tests so they do
   * not depend on a real stdin stream. Used only when neither a body argument
   * nor `--file` is given.
   */
  readInput?: () => Promise<string>;
};

// Where the note text came from. Only text read from stdin or a file has its
// trailing newlines dropped; an argument is recorded exactly as passed, as it
// always has been.
type NoteBodySource = "argument" | "file" | "stdin";

const NOTE_HELP = `
Text that contains backticks, $(...), $VAR or ! is safest on stdin through a
heredoc whose delimiter is QUOTED: the shell then passes the text through
untouched. Inside double quotes the shell runs backticks and $(...) as commands
and records their output in place of the text, without any error.

Example (heredoc on stdin):
  basou note <<'EOF'
  Next: rebase \`topic\` onto main, then rerun the $CI job.
  EOF

Keep the text on its own lines: words on the same line as <<'EOF' are ordinary
shell words, not part of the quoted text. 'basou note -' does not read stdin;
omit the argument instead.

Trailing newlines in text read from stdin or --file are dropped (a heredoc
always ends with one); everything else is recorded exactly as read.
`;

// The recommended form, always shown on three lines. Typed on ONE line, the
// words after <<'EOF' are ordinary unquoted shell words again, so backticks in
// them still run -- the very failure the heredoc is meant to prevent.
const HEREDOC_EXAMPLE = ["  basou note <<'EOF'", "  <your note>", "  EOF"].join("\n");

const NO_INPUT_HINT =
  "No note text. Pass it on stdin through a quoted heredoc, with the text on its own lines:\n" +
  `${HEREDOC_EXAMPLE}\n` +
  "or pass it as an argument, or with --file <path>.";

/**
 * Wire `basou note` onto `program`. A one-shot, free-text note that orientation
 * surfaces as the recorded next step — the in-model way to leave a
 * resume hint that survives into the next session. By default it creates an
 * ad-hoc session to hold the `note_added` event (imported sessions are not
 * attachable), mirroring `basou decision record`; `--session` attaches to an
 * existing attachable session instead. The text is the argument, or, when the
 * argument is omitted, stdin or `--file` (like `basou decision capture` and
 * `basou review record`), so text with backticks or `$(...)` can reach basou
 * without passing through a double-quoted shell word.
 */
export function registerNoteCommand(program: Command): void {
  program
    .command("note")
    .description("Record a free-text note (orientation surfaces the latest as the next step)")
    .argument("[body]", "Note text (omit it to read the text from stdin or --file)", parseBody)
    .option("--file <path>", "Read the note text from a file instead of the argument or stdin")
    .option(
      "--session <session_id>",
      "Attach to an existing session; otherwise an ad-hoc session is created",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .addHelpText("after", NOTE_HELP)
    .action(async (body: string | undefined, options: NoteOptions) => {
      await runNote(body, options);
    });
}

/**
 * Programmatic entry for `basou note`. Owns process exit state. Tests targeting
 * the success path or the thrown error should prefer {@link doRunNote}.
 */
export async function runNote(
  body: string | undefined,
  options: NoteOptions,
  ctx: NoteContext = {},
): Promise<void> {
  try {
    await doRunNote(body, options, ctx);
  } catch (error: unknown) {
    // The ad-hoc path writes the note_added event before finalizing
    // session.yaml; on a finalize failure the classifier surfaces "do not
    // rerun" so the operator does not append a duplicate note (mirrors
    // `basou decision record`).
    renderCliError(error, {
      verbose: isVerbose(options),
      classifiers: [failedToFinalizeClassifier],
    });
    process.exitCode = 1;
  }
}

export async function doRunNote(
  bodyArgument: string | undefined,
  options: NoteOptions,
  ctx: NoteContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const { body, source } = await readNoteBody(bodyArgument, options, ctx, cwd);
  // Nothing on stdin is almost always "forgot to pipe the text", not an
  // intentionally empty note, so say where the text can come from.
  if (source === "stdin" && body.trim().length === 0) {
    throw new Error(NO_INPUT_HINT);
  }
  // The one empty-body check every source passes through: parseBody rejects an
  // empty argument at the command line, but text from stdin or --file, and a
  // programmatic call, reach only this. Whitespace-only is treated as empty
  // (mirrors `basou session note`).
  if (body.trim().length === 0) {
    throw new Error("Note body must not be empty");
  }
  // Footgun guard: `basou note` takes the note text as a positional argument and
  // has no subcommands, so `basou note list` silently records a note whose body
  // is the single word "list" (which then surfaces as orientation's next step).
  // Refuse a body that is exactly one subcommand-like word — no one means to
  // record that as a note — and point at the right form. A real note with more
  // than one word, or that word in a phrase, is unaffected.
  const reserved = body.trim().toLowerCase();
  if (NOTE_SUBCOMMAND_LOOKALIKES.has(reserved)) {
    throw new Error(
      `'basou note' records a free-text note and has no '${body.trim()}' subcommand. ` +
        "To record a note, pass its full text, e.g. on stdin through a quoted heredoc, " +
        `with the text on its own lines:\n${HEREDOC_EXAMPLE}`,
    );
  }
  // `-` is the usual way to say "read stdin", but here it would be recorded as
  // the note text itself and surface as the next step. Refuse it and point at
  // the form that does read stdin (omitting the argument).
  if (reserved === "-") {
    throw new Error(
      "'basou note -' does not read stdin; it would record '-' as the note. " +
        `To pass the note on stdin, omit the argument:\n${HEREDOC_EXAMPLE}`,
    );
  }

  // View-aware resolution so `basou note` works from a workspace-view dir
  // (redirects to the planning repo), matching orient / refresh / session.
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "note");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();

  if (options.session !== undefined) {
    const sessionId = await resolveSessionId(paths, options.session);
    const sesId = sessionId as PrefixedId<"ses">;
    // Per-session lock guards the events.jsonl append against a concurrent
    // writer (decision record / another note / an attach-flavoured task
    // command). appendEventToExistingSession holds no lock; the caller owns the
    // critical section.
    const sessionLock = await acquireLock(paths, "session", sesId);
    let result: Awaited<ReturnType<typeof appendEventToExistingSession>>;
    try {
      result = await appendEventToExistingSession({
        paths,
        sessionId: sesId,
        eventBuilder: (eventId) => buildNoteEvent({ eventId, sessionId: sesId, occurredAt, body }),
      });
    } finally {
      await sessionLock.release();
    }
    printNoteResult(options, {
      mode: "attached",
      sessionId,
      eventId: result.eventId,
      sessionStatus: result.sessionStatus,
      body,
    });
    return;
  }

  const manifest = await readManifest(paths);
  const adHoc = await createAdHocSessionWithEvent({
    paths,
    manifest,
    label: buildAdHocLabel(body),
    occurredAt,
    sessionSource: "human",
    workingDirectory: repositoryRoot,
    invocation: {
      command: "basou note",
      args: noteInvocationArgs({ body, source, file: options.file, cwd, repositoryRoot }),
    },
    targetEventBuilders: [
      (sessionId, eventId) => buildNoteEvent({ eventId, sessionId, occurredAt, body }),
    ],
  });
  printNoteResult(options, {
    mode: "ad-hoc",
    sessionId: adHoc.sessionId,
    eventId: adHoc.targetEventIds[0] as string,
    sessionStatus: "completed",
    body,
  });
}

function buildNoteEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  occurredAt: string;
  body: string;
}): Event {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: LOCAL_CLI_EVENT_SOURCE,
    type: "note_added",
    body: input.body,
    // `basou note` is the resume-hint command; mark it so orientation surfaces
    // it as the next step and a plain `basou session note` annotation does not.
    kind: "next_step",
  };
}

function buildAdHocLabel(body: string): string {
  // Collapse whitespace so a multi-line body still produces a single-line label.
  const oneLine = body.replace(/\s+/g, " ").trim();
  const truncated =
    oneLine.length > LABEL_BODY_MAX ? `${oneLine.slice(0, LABEL_TRUNCATE_HEAD)}...` : oneLine;
  return `Ad-hoc note: ${truncated}`;
}

/**
 * Resolve the note text from exactly one source: the argument, `--file`, or
 * (when neither is given) stdin. Text from a file or stdin loses its trailing
 * newlines, since a heredoc always ends with one; nothing else is changed.
 */
async function readNoteBody(
  bodyArgument: string | undefined,
  options: NoteOptions,
  ctx: NoteContext,
  cwd: string,
): Promise<{ body: string; source: NoteBodySource }> {
  if (bodyArgument !== undefined && options.file !== undefined) {
    throw new Error("Pass the note text either as an argument or with --file, not both.");
  }
  if (bodyArgument !== undefined) {
    return { body: bodyArgument, source: "argument" };
  }
  if (options.file !== undefined) {
    let raw: string;
    try {
      raw = await readFile(resolve(cwd, options.file), "utf8");
    } catch (error: unknown) {
      // Fixed messages, like `basou task new --from-file`: the error surface
      // never carries a path. The cause (shown with --verbose) has the detail.
      if (findErrorCode(error, "ENOENT")) {
        throw new Error("--file names a file that does not exist", { cause: error });
      }
      if (findErrorCode(error, "EISDIR")) {
        throw new Error("--file names a directory, not a file", { cause: error });
      }
      throw new Error("Could not read the file --file names", { cause: error });
    }
    return { body: dropTrailingNewlines(raw), source: "file" };
  }
  if (ctx.readInput !== undefined) {
    return { body: dropTrailingNewlines(await ctx.readInput()), source: "stdin" };
  }
  // A bare `basou note` at a terminal would otherwise wait for input forever;
  // fail fast with the hint instead (mirrors `basou review record`).
  if (process.stdin.isTTY === true) {
    throw new Error(NO_INPUT_HINT);
  }
  return { body: dropTrailingNewlines(await readStdinToEnd()), source: "stdin" };
}

// Strip trailing "\n" / "\r\n" line endings, scanning back from the end (a
// trailing-anchored regex backtracks over every interior run of newlines, which
// is quadratic on long input). A lone trailing "\r" is kept, as it is not a
// line ending.
function dropTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") {
    end -= 1;
    if (end > 0 && text[end - 1] === "\r") end -= 1;
  }
  return text.slice(0, end);
}

async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The argv recorded on the ad-hoc session, matching how the note was actually
 * passed: the text itself for an argument, the (sanitized) path for `--file`,
 * and nothing for stdin. The `--file` path is recorded the way `sanitizePath`
 * records every path (as `basou review record` does): relative to the workspace
 * when inside it, `~/`-relative inside the home directory, and as given
 * otherwise.
 */
function noteInvocationArgs(input: {
  body: string;
  source: NoteBodySource;
  file: string | undefined;
  cwd: string;
  repositoryRoot: string;
}): string[] {
  if (input.source === "argument") return [input.body];
  if (input.source === "file" && input.file !== undefined) {
    return [
      "--file",
      sanitizePath(resolve(input.cwd, input.file), {
        workingDirectory: input.repositoryRoot,
        homedir: homedir(),
      }),
    ];
  }
  return [];
}

function parseBody(raw: string): string {
  if (raw.trim().length === 0) {
    throw new InvalidArgumentError("Note body must not be empty");
  }
  return raw;
}

type NotePrintInput = {
  mode: "ad-hoc" | "attached";
  sessionId: string;
  eventId: string;
  sessionStatus: SessionStatus;
  body: string;
};

function printNoteResult(options: NoteOptions, result: NotePrintInput): void {
  const sid = shortSessionId(result.sessionId);
  if (options.json === true) {
    console.log(
      JSON.stringify({
        event_id: result.eventId,
        session_id: result.sessionId,
        session_status: result.sessionStatus,
        mode: result.mode,
        body: result.body,
      }),
    );
    return;
  }
  if (result.mode === "ad-hoc") {
    console.log(`Recorded note ${result.eventId} in ad-hoc session ${sid}`);
  } else {
    console.log(`Recorded note ${result.eventId} in session ${sid} (${result.sessionStatus})`);
  }
}

async function assertWorkspaceInitialized(basouRoot: string): Promise<void> {
  try {
    await assertBasouRootSafe(basouRoot);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Workspace not initialized. Run 'basou init' first.");
    }
    throw error;
  }
}
