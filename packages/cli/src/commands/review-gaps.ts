import {
  basouPaths,
  findReviewGaps,
  type ReviewGapsSummary,
  type ReviewGapUnit,
} from "@basou/core";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import {
  isVerbose,
  printReplayWarning,
  printSessionSkip,
  renderCliError,
} from "../lib/error-render.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import type { ImportContext } from "./import.js";

export type ReviewGapsOptions = {
  repo?: string[];
  window?: number;
  json?: boolean;
  verbose?: boolean;
};

export type ReviewGapsContext = ImportContext & {
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/** Commander collector: accumulate a repeatable `--repo` into an array. */
function collectRepo(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Commander parser: `--window` is a positive integer count of hours. */
export function parseWindow(value: string): number {
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours <= 0) {
    throw new InvalidArgumentError("--window must be a positive integer (hours).");
  }
  return hours;
}

/**
 * Wire `basou review-gaps` onto `program`. A read-only, advisory check for the
 * "external adversarial review before commit" protocol: it surfaces units of
 * work that landed commits with NO bound cross-model (Codex) review trail. It
 * never claims a unit WAS reviewed — temporal proximity is not binding — so it
 * surfaces suspicion and leaves the final call to the operator. It writes
 * nothing and enforces nothing.
 */
export function registerReviewGapsCommand(program: Command): void {
  program
    .command("review-gaps")
    .description(
      "Surface units of work committed without a bound cross-model review trail (read-only, advisory)",
    )
    .option(
      "--repo <name>",
      "Restrict to a repo by name (repeatable; default: every repo with captured commits)",
      collectRepo,
      [],
    )
    .option(
      "--window <hours>",
      "Hours before a commit to look for a review (default 24)",
      parseWindow,
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ReviewGapsOptions) => {
      await runReviewGaps(opts);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunReviewGaps}. */
export async function runReviewGaps(
  options: ReviewGapsOptions,
  ctx: ReviewGapsContext = {},
): Promise<void> {
  try {
    await doRunReviewGaps(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** Pure runner: resolves the workspace, computes the summary, prints it (or JSON). */
export async function doRunReviewGaps(
  options: ReviewGapsOptions,
  ctx: ReviewGapsContext,
): Promise<ReviewGapsSummary> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "review-gaps");
  const paths = basouPaths(repositoryRoot);

  const nowIso = (ctx.nowProvider?.() ?? new Date()).toISOString();
  const summary = await findReviewGaps({
    paths,
    nowIso,
    ...(options.repo !== undefined && options.repo.length > 0 ? { scope: options.repo } : {}),
    ...(options.window !== undefined ? { windowHours: options.window } : {}),
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
  });

  if (options.json === true) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(renderReviewGaps(summary));
  }
  return summary;
}

function relAge(iso: string | null, now: Date): string {
  if (iso === null) return "(不明)";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "たった今";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}日前`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}時間前`;
  return `${Math.max(1, Math.floor(ms / 60_000))}分前`;
}

function unitLine(u: ReviewGapUnit, now: Date): string {
  const when = relAge(u.lastCommitAt, now);
  const head = `- ${u.repo} ${when} (${u.commitCount} commit${u.commitCount === 1 ? "" : "s"})`;
  if (u.verdict === "near_unbound") {
    const ids = u.reviews.map((r) => r.sessionId.slice(0, 14)).join(", ");
    return `${head} — 近接レビューはあるが diff/変更ファイルを確認していない [${ids}]`;
  }
  return `${head} — 紐づくクロスモデルレビューなし`;
}

function candidateLine(u: ReviewGapUnit, now: Date): string {
  const when = relAge(u.lastCommitAt, now);
  const cite = u.reviews
    .map((r) => `${r.sessionId.slice(0, 14)}${r.examinedDiff ? "(diff)" : ""}`)
    .join(", ");
  return `- ${u.repo} ${when} (${u.commitCount} commit${u.commitCount === 1 ? "" : "s"}) — レビュー形跡: ${cite}`;
}

/**
 * Render the advisory report. Leads with the gaps (units with no bound review),
 * then the candidates to confirm, then a per-repo tally. It deliberately states
 * the read-only / capture-bounded / no-auto-clear framing so the verdict is not
 * over-read.
 */
export function renderReviewGaps(summary: ReviewGapsSummary): string {
  const now = new Date(summary.generatedAt);
  const lines: string[] = [];
  const scope = summary.scope ? summary.scope.join(", ") : "全リポジトリ";
  lines.push(`# レビュー証跡のギャップ (${scope})`);
  lines.push("");

  if (summary.gaps.length === 0) {
    lines.push("✅ 取り込み済みの範囲では、レビュー証跡なしで着地した作業単位はありません。");
  } else {
    lines.push(`⚠️ レビュー証跡なしで着地した作業単位: ${summary.gaps.length}`);
    for (const u of summary.gaps) lines.push(unitLine(u, now));
  }
  lines.push("");

  if (summary.candidates.length > 0) {
    lines.push(
      `## 確認待ち (${summary.candidates.length}) — クロスモデルがレビューした形跡あり。この変更を本当に見たか確認してください`,
    );
    for (const u of summary.candidates) lines.push(candidateLine(u, now));
    lines.push("");
  }

  lines.push("## リポジトリ別");
  for (const r of summary.repos) {
    lines.push(
      `- ${r.repo}: ${r.units} 単位 (証跡なし ${r.omissionUnits} / 近接のみ ${r.nearUnboundUnits} / 確認待ち ${r.candidateUnits}${r.unknownUnits > 0 ? ` / 不明 ${r.unknownUnits}` : ""})`,
    );
  }
  lines.push("");
  lines.push(
    `注: read-only の advisory です。取り込み済みの commit のみが対象（最新取込 commit: ${summary.newestCommitAt === null ? "なし" : relAge(summary.newestCommitAt, now)}）。レビューの「実施」は自動判定せず、時間的近接だけでは合格にしません。enforce はしません。`,
  );
  return lines.join("\n");
}
