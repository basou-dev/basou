import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_INFRA_DIRS,
  acquireLock,
  appendEventToExistingSession,
  assertBasouRootSafe,
  type BasouPaths,
  basouPaths,
  classifyFilesBySourceRoot,
  createAdHocSessionWithEvent,
  type Event,
  findErrorCode,
  isValidPrefixedId,
  loadSessionEntries,
  type PrefixedId,
  prefixedUlid,
  readManifest,
  replayEvents,
  resolveRepositoryRoot,
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

// Raised from the original 40-char cap to 80 chars so a long decision
// title (= the most common ad-hoc trigger) retains its core information
// without being truncated. 80 chars still fits comfortably in
// single-column session list / handoff renderings. Operator feedback
// from real-world long-title outliers may revisit this value.
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
 * are deferred to a v0.3+ follow-up.
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

  decision
    .command("capture")
    .description(
      "Capture a batch of decisions from a JSON array (stdin or --file). The " +
        "in-loop agent extracts a session's conversational decisions -- with " +
        "rationale, alternatives, and rejected reasons -- and pipes them in; " +
        "basou writes them deterministically into one ad-hoc session.",
    )
    .option("--file <path>", "Read the JSON array from a file instead of stdin")
    .option("--dry-run", "Validate and preview the decisions without writing them")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .addHelpText("after", CAPTURE_HELP)
    .action(async (options: DecisionCaptureOptions) => {
      await runDecisionCapture(options);
    });

  decision
    .command("void")
    .description(
      "Void (or supersede) a recorded decision. Append-only: the original is " +
        "kept but struck in decisions.md and skipped as orientation's latest " +
        "direction. Use when a decision was wrong or recorded in the wrong project.",
    )
    .argument("<decision_id>", "The decision to void (its decision_ ULID)")
    .option("--reason <text>", "Why the decision is voided", parseReason)
    .option(
      "--superseded-by <decision_id>",
      "The decision that replaces this one (records a supersede rather than a plain void)",
    )
    .option(
      "--session <session_id>",
      "Attach to an existing session; otherwise an ad-hoc session is created",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (decisionId: string, options: DecisionVoidOptions) => {
      await runDecisionVoid(decisionId, options);
    });
}

const CAPTURE_HELP = `
Input format (a JSON array; one object per decision):
  [
    {
      "title": "Adopt pnpm for the monorepo",
      "rationale": "Workspace protocol and a content-addressed store fit our layout.",
      "alternatives": ["npm workspaces", "yarn"],
      "rejected_reason": "npm hoisting caused phantom-dependency bugs",
      "linked_files": ["pnpm-workspace.yaml"]
    }
  ]

Only "title" is required; every other field is optional. All decisions are
written into one ad-hoc session timestamped now, so orientation surfaces them
as the latest decisions. Run from a workspace-view directory and it resolves to
the planning repo, like 'basou orient' / 'basou refresh' / 'basou note'.

Example (heredoc on stdin):
  basou decision capture <<'JSON'
  [{ "title": "Ship the capture command", "rationale": "Close the why-capture gap" }]
  JSON
`;

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

/**
 * Advisory cross-project guardrail for the write path: warn (never block) when
 * a decision's `linked_files` resolve OUTSIDE the project's declared
 * `source_roots`. A decision captured from a session that wandered into another
 * repo can otherwise be recorded against the wrong project's master with no
 * signal. Gated to a declared `source_roots` list (a multi-repo workspace);
 * solo projects have no boundary to cross. Relative links resolve against the
 * invocation `cwd` (where the agent passed them); source roots resolve against
 * the master `repositoryRoot`. Warn-only, consistent with `basou orient` /
 * `basou import` — capture is agent-facing and must not be blocked. `note` is
 * not covered: it carries no `linked_files` to check.
 */
async function warnLinkedFilesOutsideRoots(input: {
  linkedFiles: readonly string[];
  cwd: string;
  paths: BasouPaths;
  repositoryRoot: string;
}): Promise<void> {
  if (input.linkedFiles.length === 0) return;
  try {
    // Read the manifest INSIDE the try so a missing / corrupt manifest degrades
    // to silent rather than blocking the write — the warning must never throw
    // into the caller (esp. the `--session` path, which otherwise never reads
    // the manifest).
    const manifest = await readManifest(input.paths);
    if ((manifest.import?.source_roots?.length ?? 0) === 0) return;
    const scope = await classifyFilesBySourceRoot({
      files: input.linkedFiles,
      workingDirectory: input.cwd,
      sourceRoots: manifest.import?.source_roots,
      masterRoot: input.repositoryRoot,
      extraInRoot: AGENT_INFRA_DIRS,
    });
    if (scope.outOfRoot.length === 0) return;
    const PATH_SAMPLE = 5;
    const sample = scope.outOfRoot.slice(0, PATH_SAMPLE).join(", ");
    const more =
      scope.outOfRoot.length > PATH_SAMPLE
        ? ` (... +${scope.outOfRoot.length - PATH_SAMPLE} more)`
        : "";
    console.error(
      `basou: ${scope.outOfRoot.length} linked file(s) resolve outside this project's source_roots: ${sample}${more} — this decision may belong to another project.`,
    );
  } catch {
    // Advisory only; a classification failure must never block the write.
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

  await warnLinkedFilesOutsideRoots({
    linkedFiles: rich.linked_files ?? [],
    cwd,
    paths,
    repositoryRoot,
  });

  if (options.session !== undefined) {
    const sessionId = await resolveSessionId(paths, options.session);
    const sesId = sessionId as PrefixedId<"ses">;
    // Per-session lock guards the session.yaml status read + events.jsonl
    // append window against a concurrent writer (`basou session note`,
    // another `decision record --session`, or an attach-flavoured task
    // command). `appendEventToExistingSession` itself holds no lock; the
    // caller owns the critical section.
    const sessionLock = await acquireLock(paths, "session", sesId);
    let result: Awaited<ReturnType<typeof appendEventToExistingSession>>;
    try {
      result = await appendEventToExistingSession({
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
    } finally {
      await sessionLock.release();
    }
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
    targetEventBuilders: [
      (sessionId, eventId) =>
        buildDecisionEvent({
          eventId,
          sessionId,
          decisionId,
          title: options.title,
          occurredAt,
          rich,
        }),
    ],
  });
  printDecisionResult(options, {
    mode: "ad-hoc",
    sessionId: adHoc.sessionId,
    decisionId,
    eventId: adHoc.targetEventIds[0] as string,
    sessionStatus: "completed",
    title: options.title,
    rich,
  });
}

export type DecisionCaptureOptions = {
  /** Read the JSON array from this file instead of stdin. */
  file?: string;
  /** Validate + preview without writing anything. */
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type DecisionCaptureContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
  /**
   * Defaults to reading process.stdin to EOF. Injectable for tests so they do
   * not depend on a real stdin stream. Ignored when `--file` is given.
   */
  readInput?: () => Promise<string>;
};

/** One decision in the capture input: a title plus the optional rich fields. */
type CaptureDecisionInput = { title: string } & RichDecisionFields;

/**
 * Programmatic entry for `basou decision capture`. Owns process exit state.
 * Tests targeting the success path or the thrown error should prefer
 * {@link doRunDecisionCapture}.
 */
export async function runDecisionCapture(
  options: DecisionCaptureOptions,
  ctx: DecisionCaptureContext = {},
): Promise<void> {
  try {
    await doRunDecisionCapture(options, ctx);
  } catch (error: unknown) {
    // The ad-hoc path writes the decision events before finalizing
    // session.yaml; on a finalize failure the classifier surfaces "do not
    // rerun" so the agent does not re-pipe and duplicate the batch (mirrors
    // `basou decision record`).
    renderCliError(error, {
      verbose: isVerbose(options),
      classifiers: [failedToFinalizeClassifier],
    });
    process.exitCode = 1;
  }
}

export async function doRunDecisionCapture(
  options: DecisionCaptureOptions,
  ctx: DecisionCaptureContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  // View-aware resolution (like orient / refresh / note) so capture works from
  // a workspace-view dir, redirecting to the planning repo where decisions.md
  // and orient live. `basou decision record` predates this and uses a plain
  // git-root resolver; aligning record is a separate, behavior-changing
  // follow-up, not in scope for the capture slice.
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "decision capture");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const raw = await readCaptureInput(options, ctx);
  const decisions = parseCaptureInput(raw);

  // Cross-project guardrail (warn-only): surface linked files that resolve
  // outside the declared source_roots, before the dry-run early-return so a
  // preview shows it too. The helper reads the manifest internally and degrades
  // silently on any failure, so it never blocks the write.
  await warnLinkedFilesOutsideRoots({
    linkedFiles: decisions.flatMap((d) => d.linked_files ?? []),
    cwd,
    paths,
    repositoryRoot,
  });

  if (options.dryRun === true) {
    printCapturePreview(options, decisions);
    return;
  }

  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();
  // Mint the decision ids up front, in input order. prefixedUlid is monotonic,
  // so even though every event shares `occurredAt` the ids increase with input
  // order; decisions.md and orient (which sort by occurred_at then decision id)
  // therefore preserve the agent's ordering and treat the last item as latest.
  const decisionIds = decisions.map(() => prefixedUlid("decision"));

  const manifest = await readManifest(paths);
  // Sanitize the --file path before it lands in session.yaml invocation.args:
  // an absolute path would otherwise leak the operator's machine layout into
  // persisted `.basou/` state, the same reason `working_directory` is
  // sanitized. Resolve against cwd first so a relative --file is rewritten the
  // same way readFile resolved it.
  const invocationArgs =
    options.file !== undefined
      ? [
          "--file",
          sanitizePath(resolve(cwd, options.file), {
            workingDirectory: repositoryRoot,
            homedir: homedir(),
          }),
        ]
      : [];
  const adHoc = await createAdHocSessionWithEvent({
    paths,
    manifest,
    label: buildCaptureLabel(decisions.length),
    occurredAt,
    sessionSource: "human",
    workingDirectory: repositoryRoot,
    invocation: {
      command: "basou decision capture",
      args: invocationArgs,
    },
    targetEventBuilders: decisions.map(
      (decision, index) =>
        (sessionId: PrefixedId<"ses">, eventId: PrefixedId<"evt">): Event =>
          buildDecisionEvent({
            eventId,
            sessionId,
            decisionId: decisionIds[index] as PrefixedId<"decision">,
            title: decision.title,
            occurredAt,
            rich: toRichFields(decision),
          }),
    ),
  });

  printCaptureResult(options, {
    sessionId: adHoc.sessionId,
    items: decisions.map((decision, index) => ({
      decisionId: decisionIds[index] as string,
      eventId: adHoc.targetEventIds[index] as string,
      input: decision,
    })),
  });
}

export type DecisionVoidOptions = {
  reason?: string;
  supersededBy?: string;
  session?: string;
  json?: boolean;
  verbose?: boolean;
};

/**
 * Programmatic entry for `basou decision void`. Owns process exit state; tests
 * should prefer {@link doRunDecisionVoid}.
 */
export async function runDecisionVoid(
  decisionId: string,
  options: DecisionVoidOptions,
  ctx: DecisionContext = {},
): Promise<void> {
  try {
    await doRunDecisionVoid(decisionId, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, {
      verbose: isVerbose(options),
      classifiers: [failedToFinalizeClassifier],
    });
    process.exitCode = 1;
  }
}

export async function doRunDecisionVoid(
  decisionId: string,
  options: DecisionVoidOptions,
  ctx: DecisionContext,
): Promise<void> {
  if (!isDecisionId(decisionId)) {
    throw new Error(`Invalid decision id: ${decisionId} (expected a decision_<ULID>).`);
  }
  if (options.supersededBy !== undefined && !isDecisionId(options.supersededBy)) {
    throw new Error(
      `Invalid --superseded-by id: ${options.supersededBy} (expected a decision_<ULID>).`,
    );
  }
  if (options.supersededBy === decisionId) {
    throw new Error("A decision cannot supersede itself.");
  }

  const cwd = ctx.cwd ?? process.cwd();
  // View-aware resolution (like capture / orient / refresh) so void works from
  // a workspace-view dir and targets the same master where the decision lives.
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "decision void");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  // Existence check: a void is a correction action, so a typo'd target should
  // fail loudly rather than record an event that strikes nothing.
  if (!(await decisionExists(paths, decisionId))) {
    throw new Error(
      `Decision ${decisionId} not found in this workspace. Run 'basou decisions generate' or check the id.`,
    );
  }

  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();
  const reason = options.reason;
  const supersededBy = options.supersededBy as PrefixedId<"decision"> | undefined;

  if (options.session !== undefined) {
    const sessionId = (await resolveSessionId(paths, options.session)) as PrefixedId<"ses">;
    const sessionLock = await acquireLock(paths, "session", sessionId);
    let result: Awaited<ReturnType<typeof appendEventToExistingSession>>;
    try {
      result = await appendEventToExistingSession({
        paths,
        sessionId,
        eventBuilder: (eventId) =>
          buildDecisionVoidedEvent({
            eventId,
            sessionId,
            decisionId: decisionId as PrefixedId<"decision">,
            occurredAt,
            reason,
            supersededBy,
          }),
      });
    } finally {
      await sessionLock.release();
    }
    printVoidResult(options, {
      mode: "attached",
      sessionId,
      decisionId,
      eventId: result.eventId,
      sessionStatus: result.sessionStatus,
      reason,
      supersededBy,
    });
    return;
  }

  const manifest = await readManifest(paths);
  const adHoc = await createAdHocSessionWithEvent({
    paths,
    manifest,
    label: `Ad-hoc decision void: ${decisionId}`,
    occurredAt,
    sessionSource: "human",
    workingDirectory: repositoryRoot,
    invocation: { command: "basou decision void", args: [decisionId] },
    targetEventBuilders: [
      (sessionId, eventId) =>
        buildDecisionVoidedEvent({
          eventId,
          sessionId,
          decisionId: decisionId as PrefixedId<"decision">,
          occurredAt,
          reason,
          supersededBy,
        }),
    ],
  });
  printVoidResult(options, {
    mode: "ad-hoc",
    sessionId: adHoc.sessionId,
    decisionId,
    eventId: adHoc.targetEventIds[0] as string,
    sessionStatus: "completed",
    reason,
    supersededBy,
  });
}

/** A well-formed `decision_<ULID>` id (prefix + ULID shape). */
function isDecisionId(value: string): boolean {
  return value.startsWith("decision_") && isValidPrefixedId(value);
}

/** Scan the workspace's sessions for a `decision_recorded` with `decisionId`. */
async function decisionExists(paths: BasouPaths, decisionId: string): Promise<boolean> {
  const entries = await loadSessionEntries(paths, { now: new Date() });
  for (const entry of entries) {
    const sessionDir = join(paths.sessions, entry.sessionId);
    try {
      for await (const ev of replayEvents(sessionDir, {})) {
        if (ev.type === "decision_recorded" && ev.decision_id === decisionId) return true;
      }
    } catch {
      // Unreadable session: skip; a void should not fail because an unrelated
      // session's log is corrupt.
    }
  }
  return false;
}

function buildDecisionVoidedEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  decisionId: PrefixedId<"decision">;
  occurredAt: string;
  reason: string | undefined;
  supersededBy: PrefixedId<"decision"> | undefined;
}): Event {
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "decision_voided",
    decision_id: input.decisionId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.supersededBy !== undefined ? { superseded_by: input.supersededBy } : {}),
  };
}

type VoidPrintInput = {
  mode: "ad-hoc" | "attached";
  sessionId: string;
  decisionId: string;
  eventId: string;
  sessionStatus: SessionStatus;
  reason: string | undefined;
  supersededBy: string | undefined;
};

function printVoidResult(options: DecisionVoidOptions, result: VoidPrintInput): void {
  if (options.json === true) {
    console.log(
      JSON.stringify({
        event_id: result.eventId,
        session_id: result.sessionId,
        decision_id: result.decisionId,
        session_status: result.sessionStatus,
        mode: result.mode,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.supersededBy !== undefined ? { superseded_by: result.supersededBy } : {}),
      }),
    );
    return;
  }
  const sid = shortSessionId(result.sessionId);
  const tail = result.supersededBy !== undefined ? ` (superseded by ${result.supersededBy})` : "";
  if (result.mode === "ad-hoc") {
    console.log(`Voided ${result.decisionId} in ad-hoc session ${sid}${tail}`);
  } else {
    console.log(`Voided ${result.decisionId} in session ${sid} (${result.sessionStatus})${tail}`);
  }
}

function parseReason(raw: string): string {
  if (raw.trim().length === 0) {
    throw new InvalidArgumentError("--reason must not be empty");
  }
  return raw;
}

async function readCaptureInput(
  options: DecisionCaptureOptions,
  ctx: DecisionCaptureContext,
): Promise<string> {
  if (options.file !== undefined) {
    try {
      return await readFile(options.file, "utf8");
    } catch (error: unknown) {
      if (findErrorCode(error, "ENOENT")) {
        throw new Error(`Input file not found: ${options.file}`);
      }
      throw error;
    }
  }
  if (ctx.readInput !== undefined) {
    return await ctx.readInput();
  }
  // A bare invocation with no piped stdin would otherwise block forever; fail
  // fast with the same actionable hint the empty-input guard uses.
  if (process.stdin.isTTY === true) {
    throw new Error(NO_INPUT_HINT);
  }
  return await readStdinToEnd();
}

async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const NO_INPUT_HINT = "No input: pipe a JSON array of decisions to stdin or pass --file <path>.";

const CAPTURE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "title",
  "rationale",
  "rejected_reason",
  "alternatives",
  "linked_events",
  "linked_files",
]);

/**
 * Parse + validate the capture input. Errors name the offending array index and
 * field (e.g. `decision[2].title must be a non-empty string`) so the in-loop
 * agent can self-correct its extraction without guessing.
 */
function parseCaptureInput(raw: string): CaptureDecisionInput[] {
  if (raw.trim().length === 0) {
    throw new Error(NO_INPUT_HINT);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Input is not valid JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Input must be a JSON array of decision objects.");
  }
  if (parsed.length === 0) {
    throw new Error("Input array must contain at least one decision.");
  }
  return parsed.map((item, index) => validateCaptureItem(item, index));
}

function validateCaptureItem(item: unknown, index: number): CaptureDecisionInput {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error(`decision[${index}] must be a JSON object.`);
  }
  const obj = item as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!CAPTURE_ALLOWED_KEYS.has(key)) {
      throw new Error(
        `decision[${index}]: unknown field '${key}'. Allowed: title, rationale, rejected_reason, alternatives, linked_events, linked_files.`,
      );
    }
  }
  if (typeof obj.title !== "string" || isBlank(obj.title)) {
    throw new Error(`decision[${index}].title must be a non-empty string.`);
  }
  const out: CaptureDecisionInput = { title: obj.title };
  if (obj.rationale !== undefined) {
    out.rationale = requireNonEmptyString(obj.rationale, index, "rationale");
  }
  if (obj.rejected_reason !== undefined) {
    out.rejected_reason = requireNonEmptyString(obj.rejected_reason, index, "rejected_reason");
  }
  if (obj.alternatives !== undefined) {
    out.alternatives = validateStringArray(obj.alternatives, index, "alternatives", (value, i) => {
      if (isBlank(value)) {
        throw new Error(`decision[${index}].alternatives[${i}] must not be empty.`);
      }
    });
  }
  if (obj.linked_events !== undefined) {
    out.linked_events = validateStringArray(
      obj.linked_events,
      index,
      "linked_events",
      (value, i) => {
        if (!isValidEventId(value)) {
          throw new Error(
            `decision[${index}].linked_events[${i}] must match evt_<ULID>, got '${value}'.`,
          );
        }
      },
    );
  }
  if (obj.linked_files !== undefined) {
    out.linked_files = validateStringArray(obj.linked_files, index, "linked_files", (value, i) => {
      if (isBlank(value)) {
        throw new Error(`decision[${index}].linked_files[${i}] must not be empty.`);
      }
      if (value.length > 4096) {
        throw new Error(`decision[${index}].linked_files[${i}] exceeds 4096 chars.`);
      }
    });
  }
  return out;
}

function requireNonEmptyString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || isBlank(value)) {
    throw new Error(`decision[${index}].${field} must be a non-empty string.`);
  }
  return value;
}

// Treat whitespace-only as empty: a blank title / rationale persists into
// decisions.md and orientation as an unreadable entry. `basou note` already
// guards this way; `decision record` / `decision capture` now match.
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function validateStringArray(
  value: unknown,
  index: number,
  field: string,
  checkEach: (value: string, i: number) => void,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`decision[${index}].${field} must be an array of strings.`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new Error(`decision[${index}].${field}[${i}] must be a string.`);
    }
    checkEach(entry, i);
    return entry;
  });
}

function toRichFields(decision: CaptureDecisionInput): RichDecisionFields {
  const out: RichDecisionFields = {};
  if (decision.rationale !== undefined) out.rationale = decision.rationale;
  if (decision.rejected_reason !== undefined) out.rejected_reason = decision.rejected_reason;
  if (decision.alternatives !== undefined) out.alternatives = [...decision.alternatives];
  if (decision.linked_events !== undefined) out.linked_events = [...decision.linked_events];
  if (decision.linked_files !== undefined) out.linked_files = [...decision.linked_files];
  return out;
}

function buildCaptureLabel(count: number): string {
  return `Ad-hoc capture: ${count} decision${count === 1 ? "" : "s"}`;
}

type CaptureResultItem = { decisionId: string; eventId: string; input: CaptureDecisionInput };

function captureItemToPayload(item: CaptureResultItem): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    decision_id: item.decisionId,
    event_id: item.eventId,
    title: item.input.title,
  };
  if (item.input.rationale !== undefined) payload.rationale = item.input.rationale;
  if (item.input.alternatives !== undefined) payload.alternatives = item.input.alternatives;
  if (item.input.rejected_reason !== undefined)
    payload.rejected_reason = item.input.rejected_reason;
  if (item.input.linked_events !== undefined) payload.linked_events = item.input.linked_events;
  if (item.input.linked_files !== undefined) payload.linked_files = item.input.linked_files;
  return payload;
}

function printCapturePreview(
  options: DecisionCaptureOptions,
  decisions: CaptureDecisionInput[],
): void {
  if (options.json === true) {
    console.log(JSON.stringify({ dry_run: true, count: decisions.length, decisions }));
    return;
  }
  console.log(
    `Would capture ${decisions.length} decision${decisions.length === 1 ? "" : "s"} (dry run; nothing written):`,
  );
  for (const decision of decisions) {
    console.log(`- ${decision.title}`);
  }
}

function printCaptureResult(
  options: DecisionCaptureOptions,
  result: { sessionId: string; items: CaptureResultItem[] },
): void {
  const sid = shortSessionId(result.sessionId);
  if (options.json === true) {
    console.log(
      JSON.stringify({
        mode: "ad-hoc",
        session_id: result.sessionId,
        session_status: "completed",
        count: result.items.length,
        decisions: result.items.map(captureItemToPayload),
      }),
    );
    return;
  }
  console.log(
    `Captured ${result.items.length} decision${result.items.length === 1 ? "" : "s"} in ad-hoc session ${sid}:`,
  );
  for (const item of result.items) {
    console.log(`- ${item.decisionId}: ${item.input.title}`);
  }
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
  if (isBlank(raw)) {
    throw new InvalidArgumentError("Title must not be empty");
  }
  return raw;
}

function parseRationale(raw: string): string {
  if (isBlank(raw)) {
    throw new InvalidArgumentError("Rationale must not be empty");
  }
  return raw;
}

function parseRejectedReason(raw: string): string {
  if (isBlank(raw)) {
    throw new InvalidArgumentError("Rejected reason must not be empty");
  }
  return raw;
}

function collectAlternative(value: string, prev: string[]): string[] {
  if (isBlank(value)) {
    throw new InvalidArgumentError("Alternative must not be empty");
  }
  return prev.concat(value);
}

// Validate against the canonical event-id shape (`evt_<26-char Crockford ULID>`),
// exactly what `EventIdSchema` enforces at write time. A looser check (e.g. a
// bare `evt_[A-Z0-9]+` regex) would accept ids like `evt_X` here only for the
// chained-append `EventSchema.parse` to reject them later with a generic
// "Invalid Basou event payload" error -- and would let `decision capture
// --dry-run` falsely report success. Shared by `decision record` and
// `decision capture` so both reject the same set up front.
function isValidEventId(value: string): boolean {
  return isValidPrefixedId(value) && value.startsWith("evt_");
}

function collectLinkedEvent(value: string, prev: string[]): string[] {
  if (!isValidEventId(value)) {
    throw new InvalidArgumentError(`Linked event id must match evt_<ULID>, got '${value}'`);
  }
  return prev.concat(value);
}

function collectLinkedFile(value: string, prev: string[]): string[] {
  if (isBlank(value)) {
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
    // Rich fields are now persisted into the decision_recorded event, so
    // they appear in the JSON summary as-is (the old `rationale_saved:
    // false` indicator is gone).
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
