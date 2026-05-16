import {
  type Event,
  type PrefixedId,
  type SessionStatus,
  appendEventToExistingSession,
  assertBasouRootSafe,
  basouPaths,
  createAdHocSessionWithEvent,
  findErrorCode,
  prefixedUlid,
  readManifest,
  resolveRepositoryRoot,
  resolveSessionId,
} from "@basou/core";
import { type Command, InvalidArgumentError } from "commander";
import {
  failedToFinalizeClassifier,
  isVerbose,
  renderCliError,
  shortSessionId,
} from "../lib/error-render.js";

// Y-3z #63 / B-G1: raised from the original 40-char cap to 80 chars so a
// long decision title (= the most common ad-hoc trigger) retains its core
// information without being truncated. 80 chars still fits comfortably in
// single-column session list / handoff renderings. fb-driven re-tuning
// may revisit this value (see Y-3v §4.3).
const LABEL_TITLE_MAX = 80;
const LABEL_TRUNCATE_HEAD = LABEL_TITLE_MAX - 3;

export type DecisionRecordOptions = {
  title: string;
  rationale?: string;
  rejectedReason?: string;
  alternative?: string[];
  linkedEvent?: string[];
  linkedFile?: string[];
  session?: string;
  json?: boolean;
  verbose?: boolean;
};

export type DecisionContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/**
 * Wire `basou decision record` onto `program`. The `decision` group only
 * contains the write-side `record` subcommand in v0.1; list/show inspectors
 * are deferred (see Y-3s carryover #41).
 */
export function registerDecisionCommand(program: Command): void {
  const decision = program
    .command("decision")
    .description("Record human-authored decisions as events");

  decision
    .command("record")
    .description("Record a decision_recorded event")
    .requiredOption("--title <text>", "Decision title", parseTitle)
    .option("--rationale <text>", "Rationale for the decision", parseRationale)
    .option(
      "--rejected-reason <text>",
      "Reason rejected alternatives were not chosen",
      parseRejectedReason,
    )
    .option(
      "--alternative <text>",
      "Alternative considered (repeatable: --alternative yup --alternative joi)",
      collectAlternative,
      [] as string[],
    )
    .option(
      "--linked-event <event_id>",
      "Related event id (repeatable). Schema only checks the prefix; existence is verified at render time.",
      collectLinkedEvent,
      [] as string[],
    )
    .option(
      "--linked-file <path>",
      "Related file path (repeatable). Path is opaque; existence is verified at render time.",
      collectLinkedFile,
      [] as string[],
    )
    .option(
      "--session <session_id>",
      "Attach to an existing session; otherwise an ad-hoc session is created",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: DecisionRecordOptions) => {
      await runDecisionRecord(options);
    });
}

/**
 * Programmatic entry for `basou decision record`. Owns process exit state.
 * Tests targeting the success path or the thrown error should prefer
 * {@link doRunDecisionRecord}.
 */
export async function runDecisionRecord(
  options: DecisionRecordOptions,
  ctx: DecisionContext = {},
): Promise<void> {
  try {
    await doRunDecisionRecord(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, {
      verbose: isVerbose(options),
      classifiers: [failedToFinalizeClassifier],
    });
    process.exitCode = 1;
  }
}

export async function doRunDecisionRecord(
  options: DecisionRecordOptions,
  ctx: DecisionContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForDecision(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();
  const decisionId = prefixedUlid("decision");

  const rich = pickRichFields(options);

  if (options.session !== undefined) {
    const sessionId = await resolveSessionId(paths, options.session);
    const sesId = sessionId as PrefixedId<"ses">;
    const result = await appendEventToExistingSession({
      paths,
      sessionId: sesId,
      eventBuilder: (eventId) =>
        buildDecisionEvent({
          eventId,
          sessionId: sesId,
          decisionId,
          title: options.title,
          occurredAt,
          rich,
        }),
    });
    printDecisionResult(options, {
      mode: "attached",
      sessionId,
      decisionId,
      eventId: result.eventId,
      sessionStatus: result.sessionStatus,
      title: options.title,
      rich,
    });
    return;
  }

  const manifest = await readManifest(paths);
  const adHoc = await createAdHocSessionWithEvent({
    paths,
    manifest,
    label: buildAdHocLabel(options.title),
    occurredAt,
    sessionSource: "human",
    workingDirectory: repositoryRoot,
    invocation: {
      command: "basou decision record",
      args: ["--title", options.title],
    },
    targetEventBuilder: (sessionId, eventId) =>
      buildDecisionEvent({
        eventId,
        sessionId,
        decisionId,
        title: options.title,
        occurredAt,
        rich,
      }),
  });
  printDecisionResult(options, {
    mode: "ad-hoc",
    sessionId: adHoc.sessionId,
    decisionId,
    eventId: adHoc.targetEventId,
    sessionStatus: "completed",
    title: options.title,
    rich,
  });
}

type RichDecisionFields = {
  rationale?: string;
  rejected_reason?: string;
  alternatives?: string[];
  linked_events?: string[];
  linked_files?: string[];
};

function pickRichFields(options: DecisionRecordOptions): RichDecisionFields {
  const out: RichDecisionFields = {};
  if (options.rationale !== undefined) out.rationale = options.rationale;
  if (options.rejectedReason !== undefined) out.rejected_reason = options.rejectedReason;
  if (options.alternative !== undefined && options.alternative.length > 0) {
    out.alternatives = [...options.alternative];
  }
  if (options.linkedEvent !== undefined && options.linkedEvent.length > 0) {
    out.linked_events = [...options.linkedEvent];
  }
  if (options.linkedFile !== undefined && options.linkedFile.length > 0) {
    out.linked_files = [...options.linkedFile];
  }
  return out;
}

function buildDecisionEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  decisionId: PrefixedId<"decision">;
  title: string;
  occurredAt: string;
  rich: RichDecisionFields;
}): Event {
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "decision_recorded",
    decision_id: input.decisionId,
    title: input.title,
    ...(input.rich.rationale !== undefined ? { rationale: input.rich.rationale } : {}),
    ...(input.rich.alternatives !== undefined ? { alternatives: input.rich.alternatives } : {}),
    ...(input.rich.rejected_reason !== undefined
      ? { rejected_reason: input.rich.rejected_reason }
      : {}),
    ...(input.rich.linked_events !== undefined
      ? { linked_events: input.rich.linked_events as Array<`evt_${string}`> }
      : {}),
    ...(input.rich.linked_files !== undefined ? { linked_files: input.rich.linked_files } : {}),
  };
}

function buildAdHocLabel(title: string): string {
  const truncated =
    title.length > LABEL_TITLE_MAX ? `${title.slice(0, LABEL_TRUNCATE_HEAD)}...` : title;
  return `Ad-hoc decision: ${truncated}`;
}

function parseTitle(raw: string): string {
  if (raw.length === 0) {
    throw new InvalidArgumentError("Title must not be empty");
  }
  return raw;
}

function parseRationale(raw: string): string {
  if (raw.length === 0) {
    throw new InvalidArgumentError("Rationale must not be empty");
  }
  return raw;
}

function parseRejectedReason(raw: string): string {
  if (raw.length === 0) {
    throw new InvalidArgumentError("Rejected reason must not be empty");
  }
  return raw;
}

function collectAlternative(value: string, prev: string[]): string[] {
  if (value.length === 0) {
    throw new InvalidArgumentError("Alternative must not be empty");
  }
  return prev.concat(value);
}

const EVENT_ID_RE = /^evt_[A-Z0-9]+$/;

function collectLinkedEvent(value: string, prev: string[]): string[] {
  if (!EVENT_ID_RE.test(value)) {
    throw new InvalidArgumentError(`Linked event id must match evt_<ULID>, got '${value}'`);
  }
  return prev.concat(value);
}

function collectLinkedFile(value: string, prev: string[]): string[] {
  if (value.length === 0) {
    throw new InvalidArgumentError("Linked file path must not be empty");
  }
  if (value.length > 4096) {
    throw new InvalidArgumentError("Linked file path exceeds 4096 chars");
  }
  return prev.concat(value);
}

type DecisionPrintInput = {
  mode: "ad-hoc" | "attached";
  sessionId: string;
  decisionId: string;
  eventId: string;
  sessionStatus: SessionStatus;
  title: string;
  rich: RichDecisionFields;
};

function printDecisionResult(options: DecisionRecordOptions, result: DecisionPrintInput): void {
  const sid = shortSessionId(result.sessionId);
  if (options.json === true) {
    const payload: Record<string, unknown> = {
      decision_id: result.decisionId,
      event_id: result.eventId,
      session_id: result.sessionId,
      session_status: result.sessionStatus,
      mode: result.mode,
      title: result.title,
    };
    // Y-3z #40 / B-F1: rich fields are now persisted into the
    // decision_recorded event, so they appear in the JSON summary as-is
    // (the old `rationale_saved: false` indicator is gone).
    if (result.rich.rationale !== undefined) payload.rationale = result.rich.rationale;
    if (result.rich.alternatives !== undefined) payload.alternatives = result.rich.alternatives;
    if (result.rich.rejected_reason !== undefined) {
      payload.rejected_reason = result.rich.rejected_reason;
    }
    if (result.rich.linked_events !== undefined) payload.linked_events = result.rich.linked_events;
    if (result.rich.linked_files !== undefined) payload.linked_files = result.rich.linked_files;
    console.log(JSON.stringify(payload));
    return;
  }
  const rationaleSuffix =
    result.rich.rationale !== undefined ? ` (rationale: ${result.rich.rationale})` : "";
  if (result.mode === "ad-hoc") {
    console.log(`Recorded ${result.decisionId} in ad-hoc session ${sid}${rationaleSuffix}`);
  } else {
    console.log(
      `Recorded ${result.decisionId} in session ${sid} (${result.sessionStatus})${rationaleSuffix}`,
    );
  }
}

async function resolveRepositoryRootForDecision(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        "Not a git repository. Run 'git init' first, then re-run 'basou decision record'.",
        { cause: error },
      );
    }
    throw error;
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
