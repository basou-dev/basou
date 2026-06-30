import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  assertBasouRootSafe,
  basouPaths,
  buildReviewRecordedEvent,
  buildReviewRecordLabel,
  createAdHocSessionWithEvent,
  findErrorCode,
  type PrefixedId,
  parseReviewRecordInput,
  type ReviewRecordInput,
  readManifest,
  sanitizePath,
} from "@basou/core";
import type { Command } from "commander";
import {
  failedToFinalizeClassifier,
  isVerbose,
  renderCliError,
  shortSessionId,
} from "../lib/error-render.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";

/**
 * Wire `basou review record` onto `program`. The twin of
 * `basou decision capture`: the in-loop agent runs an adversarial /
 * second-opinion review with a vendor-specific command, then pipes a JSON
 * object describing what ran; basou writes a `review_recorded` event
 * deterministically (no runtime LLM). The record is the durable signal that a
 * review happened — and the durable home for the "what I blocked" report the
 * adversarial-review protocol requires.
 *
 * v0.1 only has the write-side `record` subcommand; a read-side inspector and
 * the Stop-gate that consumes the record are follow-on slices.
 */
export function registerReviewCommand(program: Command): void {
  const review = program
    .command("review")
    .description("Record reviews that ran (the durable signal a review happened)");

  review
    .command("record")
    .description(
      "Record that a review ran, from a JSON object (stdin or --file). The " +
        "in-loop agent runs an adversarial / second-opinion review and pipes a " +
        "description -- reviewer, target, optional verdict/findings/blocked -- " +
        "and basou writes one review_recorded event deterministically.",
    )
    .option("--file <path>", "Read the JSON object from a file instead of stdin")
    .option("--dry-run", "Validate and preview the review without writing it")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .addHelpText("after", REVIEW_RECORD_HELP)
    .action(async (options: ReviewRecordOptions) => {
      await runReviewRecord(options);
    });
}

const REVIEW_RECORD_HELP = `
Input format (a single JSON object describing one review):
  {
    "reviewer": "codex",
    "target":   "working-tree",
    "verdict":  "needs-attention",
    "findings": [
      { "title": "Off-by-one in pager", "severity": "medium", "location": "src/page.ts:42", "summary": "..." }
    ],
    "blocked": [
      { "title": "Reviewer wanted to drop the singleton", "reason": "design-reversal", "why": "Settled in decision_X" }
    ]
  }

Only "reviewer" and "target" are required; verdict / findings / blocked are
optional. Record blocked findings (spec-deviation / design-reversal) here so the
adversarial-review protocol's "always report what you blocked" becomes a durable
trail artifact -- an explicit empty "blocked": [] is encouraged to record that
you blocked nothing. The review is written into one ad-hoc session timestamped
now. Run from a workspace-view directory and it resolves to the planning repo,
like 'basou decision capture' / 'basou note'.

Example (heredoc on stdin):
  basou review record <<'JSON'
  { "reviewer": "codex", "target": "working-tree", "verdict": "pass", "blocked": [] }
  JSON
`;

export type ReviewRecordOptions = {
  /** Read the JSON object from this file instead of stdin. */
  file?: string;
  /** Validate + preview without writing anything. */
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ReviewRecordContext = {
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

/**
 * Programmatic entry for `basou review record`. Owns process exit state. Tests
 * targeting the success path or the thrown error should prefer
 * {@link doRunReviewRecord}.
 */
export async function runReviewRecord(
  options: ReviewRecordOptions,
  ctx: ReviewRecordContext = {},
): Promise<void> {
  try {
    await doRunReviewRecord(options, ctx);
  } catch (error: unknown) {
    // The ad-hoc path writes the review event before finalizing session.yaml;
    // on a finalize failure the classifier surfaces "do not rerun" so the agent
    // does not re-pipe and duplicate the record (mirrors `basou decision capture`).
    renderCliError(error, {
      verbose: isVerbose(options),
      classifiers: [failedToFinalizeClassifier],
    });
    process.exitCode = 1;
  }
}

export async function doRunReviewRecord(
  options: ReviewRecordOptions,
  ctx: ReviewRecordContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  // View-aware resolution (like decision capture / orient / note) so review
  // record works from a workspace-view dir, redirecting to the planning repo
  // where the trail lives.
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "review record");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const raw = await readReviewInput(options, ctx);
  const review = parseReviewRecordInput(raw);

  if (options.dryRun === true) {
    printReviewPreview(options, review);
    return;
  }

  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();
  const manifest = await readManifest(paths);
  // Sanitize the --file path before it lands in session.yaml invocation.args:
  // an absolute path would otherwise leak the operator's machine layout into
  // persisted `.basou/` state (same reason `decision capture` sanitizes it).
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
    label: buildReviewRecordLabel(review),
    occurredAt,
    sessionSource: "human",
    workingDirectory: repositoryRoot,
    invocation: { command: "basou review record", args: invocationArgs },
    targetEventBuilders: [
      (sessionId: PrefixedId<"ses">, eventId: PrefixedId<"evt">) =>
        buildReviewRecordedEvent({ eventId, sessionId, occurredAt, review }),
    ],
  });

  printReviewResult(options, {
    sessionId: adHoc.sessionId,
    eventId: adHoc.targetEventIds[0] as string,
    review,
  });
}

async function readReviewInput(
  options: ReviewRecordOptions,
  ctx: ReviewRecordContext,
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
  // fast with the actionable hint the empty-input guard uses.
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

const NO_INPUT_HINT =
  "No input: pipe a JSON object describing the review to stdin or pass --file <path>.";

function reviewToPayload(review: ReviewRecordInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    reviewer: review.reviewer,
    target: review.target,
  };
  if (review.verdict !== undefined) payload.verdict = review.verdict;
  if (review.findings !== undefined) payload.findings = review.findings;
  if (review.blocked !== undefined) payload.blocked = review.blocked;
  return payload;
}

function reviewSummaryLine(review: ReviewRecordInput): string {
  const parts: string[] = [];
  if (review.verdict !== undefined) parts.push(`verdict: ${review.verdict}`);
  if (review.findings !== undefined) {
    parts.push(`${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}`);
  }
  if (review.blocked !== undefined) {
    parts.push(`${review.blocked.length} blocked`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function printReviewPreview(options: ReviewRecordOptions, review: ReviewRecordInput): void {
  if (options.json === true) {
    console.log(JSON.stringify({ dry_run: true, review: reviewToPayload(review) }));
    return;
  }
  console.log(
    `Would record review by ${review.reviewer} of ${review.target}${reviewSummaryLine(review)} (dry run; nothing written).`,
  );
}

function printReviewResult(
  options: ReviewRecordOptions,
  result: { sessionId: string; eventId: string; review: ReviewRecordInput },
): void {
  const sid = shortSessionId(result.sessionId);
  if (options.json === true) {
    console.log(
      JSON.stringify({
        mode: "ad-hoc",
        session_id: result.sessionId,
        session_status: "completed",
        event_id: result.eventId,
        review: reviewToPayload(result.review),
      }),
    );
    return;
  }
  console.log(
    `Recorded review by ${result.review.reviewer} of ${result.review.target}${reviewSummaryLine(result.review)} in ad-hoc session ${sid}.`,
  );
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
