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

const LABEL_TITLE_MAX = 40;
const LABEL_TRUNCATE_HEAD = LABEL_TITLE_MAX - 3;

export type DecisionRecordOptions = {
  title: string;
  rationale?: string;
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
    .option(
      "--rationale <text>",
      "Optional rationale (echoed to stdout summary only; not stored in v0.1)",
      parseRationale,
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
        }),
    });
    printDecisionResult(options, {
      mode: "attached",
      sessionId,
      decisionId,
      eventId: result.eventId,
      sessionStatus: result.sessionStatus,
      title: options.title,
      ...(options.rationale !== undefined ? { rationale: options.rationale } : {}),
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
      }),
  });
  printDecisionResult(options, {
    mode: "ad-hoc",
    sessionId: adHoc.sessionId,
    decisionId,
    eventId: adHoc.targetEventId,
    sessionStatus: "completed",
    title: options.title,
    ...(options.rationale !== undefined ? { rationale: options.rationale } : {}),
  });
}

function buildDecisionEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  decisionId: PrefixedId<"decision">;
  title: string;
  occurredAt: string;
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

type DecisionPrintInput = {
  mode: "ad-hoc" | "attached";
  sessionId: string;
  decisionId: string;
  eventId: string;
  sessionStatus: SessionStatus;
  title: string;
  rationale?: string;
};

function printDecisionResult(options: DecisionRecordOptions, result: DecisionPrintInput): void {
  const sid = shortSessionId(result.sessionId);
  if (options.json === true) {
    // Y3s-M3: when rationale is present, surface `rationale_saved:false` so
    // the JSON consumer knows the value was echoed but not persisted.
    const payload: Record<string, unknown> = {
      decision_id: result.decisionId,
      event_id: result.eventId,
      session_id: result.sessionId,
      session_status: result.sessionStatus,
      mode: result.mode,
      title: result.title,
    };
    if (result.rationale !== undefined) {
      payload.rationale = result.rationale;
      payload.rationale_saved = false;
    }
    console.log(JSON.stringify(payload));
    return;
  }
  const rationaleSuffix =
    result.rationale !== undefined ? ` (rationale: ${result.rationale}, not saved in v0.1)` : "";
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
