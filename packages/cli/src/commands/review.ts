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
  findUnbindableRepos,
  type PrefixedId,
  parseReviewRecordInput,
  type RepoPathProblem,
  type ReviewRecordInput,
  readManifest,
  resolveRepoRoot,
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
    "repos":    ["~/projects/basou"],
    "commits":  ["a1b2c3d"],
    "verdict":  "needs-attention",
    "findings": [
      { "title": "Off-by-one in pager", "severity": "medium", "location": "src/page.ts:42", "summary": "..." }
    ],
    "blocked": [
      { "title": "Reviewer wanted to drop the singleton", "reason": "design-reversal", "why": "Settled in decision_X" }
    ]
  }

Only "reviewer" and "target" are required; the rest are optional. Record blocked
findings (spec-deviation / design-reversal) here so the adversarial-review
protocol's "always report what you blocked" becomes a durable trail artifact --
an explicit empty "blocked": [] is encouraged to record that you blocked
nothing. The review is written into one ad-hoc session timestamped now. Run from
a workspace-view directory and it resolves to the planning repo, like
'basou decision capture' / 'basou note'.

Name the repositories you reviewed in "repos". The record lands in the planning
repo, so that field is the only thing tying it to the repo under review: without
it, 'basou review-gaps' cannot surface this record against the work it covered.
Each entry must be an absolute path (or ~/...) to a repository ROOT; a relative
path, a path that is not there, or a subdirectory is rejected outright, because
it would store a record that can never appear against any work. "commits" is
kept as your claim about coverage and is never used to bind.

A recorded review is a self-report -- review-gaps labels the unit but still
counts it as a gap, because nothing corroborates the claim. Recording after the
commit is fine: the record is still shown, marked as written after the fact.

Example (heredoc on stdin):
  basou review record <<'JSON'
  { "reviewer": "codex", "target": "working-tree", "repos": ["~/projects/basou"], "verdict": "pass", "blocked": [] }
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
  assertReposCanBind(review);
  // Resolved here, at the one moment the filesystem state that made the entries
  // valid is known to hold.
  const reposResolved = (review.repos ?? [])
    .map((r) => resolveRepoRoot(r))
    .filter((r): r is string => r !== null);

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
        buildReviewRecordedEvent({ eventId, sessionId, occurredAt, review, reposResolved }),
    ],
  });

  printReviewResult(options, {
    sessionId: adHoc.sessionId,
    eventId: adHoc.targetEventIds[0] as string,
    review,
  });
}

const REPO_PROBLEM_HINT: Record<RepoPathProblem, string> = {
  relative: "use an absolute path (or ~/...) to the repository root",
  absent: "no such path on this machine",
  not_a_repo_root: "that path is inside a repository, not its root",
};

/**
 * Reject `repos` entries that could never bind to a unit of work, checked with
 * the same definition of a repository key `basou review-gaps` binds with.
 *
 * Structural validation happens in core's pure parser; this needs the disk, so
 * it lives here. It is a hard error rather than a warning because a record that
 * cannot bind is worse than no record: it is stored, it counts as a review
 * having been written down, and it silently never appears against the work it
 * claims to cover.
 */
function assertReposCanBind(review: ReviewRecordInput): void {
  const entries = review.repos ?? [];
  const unbindable = findUnbindableRepos(entries);
  if (unbindable.length === 0) return;
  // Named by INDEX, never by value. The CLI's error surface is contractually
  // pathless, and `sanitizePath` cannot make it so here: it relativises a path
  // under the workspace or home and returns anything else verbatim, so an entry
  // like /Volumes/<client>/… would reach stderr and any captured log intact.
  // The caller supplied the array, so the index identifies the entry exactly.
  const detail = unbindable
    .map(({ repo, problem }) => `  repos[${entries.indexOf(repo)}] — ${REPO_PROBLEM_HINT[problem]}`)
    .join("\n");
  throw new Error(
    `${unbindable.length} of ${review.repos?.length} 'repos' entr${unbindable.length === 1 ? "y" : "ies"} cannot be bound to a repository:\n${detail}\n` +
      "'repos' is what ties this record to the repository it reviewed, so an " +
      "entry that resolves to nothing would leave the record stored but invisible.",
  );
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
  if (review.repos !== undefined) payload.repos = review.repos;
  if (review.commits !== undefined) payload.commits = review.commits;
  if (review.verdict !== undefined) payload.verdict = review.verdict;
  if (review.findings !== undefined) payload.findings = review.findings;
  if (review.blocked !== undefined) payload.blocked = review.blocked;
  return payload;
}

function reviewSummaryLine(review: ReviewRecordInput): string {
  const parts: string[] = [];
  if (review.verdict !== undefined) parts.push(`verdict: ${review.verdict}`);
  // Surface the repo count so the agent can see at a glance whether this record
  // is bindable by review-gaps at all.
  if (review.repos !== undefined) {
    parts.push(`${review.repos.length} repo${review.repos.length === 1 ? "" : "s"}`);
  }
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
