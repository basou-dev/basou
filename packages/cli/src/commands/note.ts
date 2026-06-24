import {
  acquireLock,
  appendEventToExistingSession,
  assertBasouRootSafe,
  basouPaths,
  createAdHocSessionWithEvent,
  type Event,
  findErrorCode,
  type PrefixedId,
  readManifest,
  resolveSessionId,
  type SessionStatus,
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
  json?: boolean;
  verbose?: boolean;
};

export type NoteContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/**
 * Wire `basou note` onto `program`. A one-shot, free-text note that orientation
 * surfaces as the recorded next step ("次の起点") — the in-model way to leave a
 * resume hint that survives into the next session. By default it creates an
 * ad-hoc session to hold the `note_added` event (imported sessions are not
 * attachable), mirroring `basou decision record`; `--session` attaches to an
 * existing attachable session instead.
 */
export function registerNoteCommand(program: Command): void {
  program
    .command("note")
    .description("Record a free-text note (orientation surfaces the latest as the next step)")
    .argument("<body>", "Note text", parseBody)
    .option(
      "--session <session_id>",
      "Attach to an existing session; otherwise an ad-hoc session is created",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (body: string, options: NoteOptions) => {
      await runNote(body, options);
    });
}

/**
 * Programmatic entry for `basou note`. Owns process exit state. Tests targeting
 * the success path or the thrown error should prefer {@link doRunNote}.
 */
export async function runNote(
  body: string,
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
  body: string,
  options: NoteOptions,
  ctx: NoteContext,
): Promise<void> {
  // Defense in depth: the commander parser (parseBody) rejects an empty body,
  // but doRunNote is also a public programmatic entry, so guard here too
  // (mirrors `basou session note`). Whitespace-only is treated as empty.
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
        'To record a note, pass its full text (e.g. `basou note "<your note>"`).',
    );
  }

  const cwd = ctx.cwd ?? process.cwd();
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
      args: [body],
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
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
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
