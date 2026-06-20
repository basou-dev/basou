import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { loadSessionEntries, type SessionSkipReason } from "../storage/sessions.js";

/**
 * Review-gap surfacer: a read-only, advisory check for the "external
 * adversarial review before commit" protocol. For each unit of work that landed
 * commits, it asks whether a CROSS-MODEL review session (a different vendor than
 * the one that wrote the code — here: Codex) actually examined that repo's diff
 * before the commit.
 *
 * Hard design rule, learned from killing the naive time-window v1 (which
 * false-cleared the very omission that motivated this): it NEVER emits a
 * confident "reviewed / clear" verdict. Temporal proximity is not binding. The
 * worst failure mode is falsely reassuring the operator that a protocol was
 * followed when it was not, so this surfaces SUSPICION and leaves the final
 * binding to a human:
 *
 *  - `omission`      no cross-model review of this repo in the preceding window.
 *  - `near_unbound`  a review session was nearby but did not examine this repo's
 *                    diff or any changed file (the exact class naive v1 cleared).
 *  - `candidate`     a review session examined this repo's diff / overlapping
 *                    files — listed for the human to confirm it covered THIS
 *                    change. NOT an automatic pass.
 *  - `unknown`       the repo or time could not be derived; abstain rather than
 *                    guess (an abstention is never counted as a clear).
 *
 * It reads only captured provenance and writes nothing.
 */

export type ReviewGapVerdict = "omission" | "near_unbound" | "candidate" | "unknown";

/** A cross-model review session cited as (possibly) covering a unit of work. */
export type CitedReview = {
  sessionId: string;
  /** The session ran `git diff` / `git show` in the repo (examined the diff). */
  examinedDiff: boolean;
  /** Basenames of files the session read/inspected in the repo (capped). */
  files: string[];
  endedAt: string | null;
};

/** One unit of work (a committing session's commits in one repo) and its verdict. */
export type ReviewGapUnit = {
  repo: string;
  /** The session whose commits form this unit. */
  sessionId: string;
  commitCount: number;
  firstCommitAt: string | null;
  lastCommitAt: string | null;
  verdict: ReviewGapVerdict;
  /** For `candidate` / `near_unbound`: the review sessions considered. */
  reviews: CitedReview[];
};

export type ReviewGapRepoSummary = {
  repo: string;
  units: number;
  omissionUnits: number;
  nearUnboundUnits: number;
  candidateUnits: number;
  unknownUnits: number;
};

export type ReviewGapsSummary = {
  generatedAt: string;
  windowHours: number;
  /** Repos the scope was restricted to, or null when every repo was considered. */
  scope: string[] | null;
  repos: ReviewGapRepoSummary[];
  /** Units WITHOUT a binding review trail (omission + near_unbound), recent-first. */
  gaps: ReviewGapUnit[];
  /** Units WITH a review candidate, recent-first (surfaced for confirmation). */
  candidates: ReviewGapUnit[];
  /** Units whose repo/time could not be derived from the captured command; abstained, not cleared. */
  unknowns: ReviewGapUnit[];
  /** Newest captured commit considered; commits not yet imported are invisible. */
  newestCommitAt: string | null;
};

/** Strip one layer of matching surrounding quotes (e.g. `cd "…/repo"`). */
function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Normalize a path to a stable BINDING key: the full path (NOT just a basename),
 * so a commit in `/u/projects/basou` and a review in `/u/projects/basou` bind,
 * while a same-named checkout elsewhere (`/tmp/x/basou`) does not. A workspace
 * "view" reaches sibling repos through symlinks
 * (`foo-workspace/foo-planning -> ../foo-planning`), and commits are often run
 * with `cd <view>/<repo>`; both the view-routed path and the direct path
 * collapse to the same key. Returns null for a view root itself, an unexpanded
 * shell var, or empty input.
 */
export function normalizeRepoPath(p: string | null | undefined): string | null {
  if (!p) return null;
  let s = stripQuotes(p.trim()).replace(/\/+$/, "");
  if (s.length === 0 || s === "~") return null;
  // expand a leading ~ so the same repo recorded as `~/projects/x` and
  // `/Users/u/projects/x` collapses to one binding key (the events capture both).
  if (s.startsWith("~/")) s = homedir() + s.slice(1);
  // a path THROUGH a *-workspace view: .../foo-workspace/foo-planning -> .../foo-planning
  s = s.replace(/\/[^/]*-workspace\/([^/]+)/, "/$1");
  const seg = s
    .split("/")
    .filter((x) => x.length > 0)
    .pop();
  if (seg === undefined) return null;
  // the view dir itself is not a repo; an unexpanded shell var is not a repo
  if (/-workspace$/.test(seg) || seg.includes("$")) return null;
  return s;
}

/**
 * Short repo key (the final path segment) for DISPLAY and `--scope` matching.
 * Binding uses {@link normalizeRepoPath} to avoid basename collisions; this is
 * only the human-facing label.
 */
export function normalizeRepoKey(p: string | null | undefined): string | null {
  const full = normalizeRepoPath(p);
  return full === null ? null : basename(full);
}

/** Files a single command read/inspected, and whether it inspected the git diff. */
function inspectCommand(args: string[]): { files: string[]; examinedDiff: boolean } {
  const a = args.join(" ");
  const files = new Set<string>();
  const examinedDiff = /\bgit\s+(?:diff|show|log\s+-p|add\s+-p)\b/.test(a);
  for (const re of [
    /\b(?:cat|less|bat|head|tail)\s+([^\s|&;<>]+)/g,
    /\bsed\s+-n\s+'[^']*'\s+([^\s|&;<>]+)/g,
    /\b(?:rg|grep)\b[^|&;]*?\s([^\s|&;<>]+\.[A-Za-z0-9]+)(?:\s|$)/g,
  ]) {
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = re.exec(a)) !== null) {
      const f = m[1];
      if (f !== undefined) files.add(basename(f));
    }
  }
  return { files: [...files], examinedDiff };
}

/** Repo a command effectively ran in: an explicit `cd <repo> &&` wins over cwd. */
function commandRepo(args: string[], cwd: string): string | null {
  const cd = args.join(" ").match(/\bcd\s+("[^"]+"|'[^']+'|[^\s&]+)\s*&&/);
  return normalizeRepoPath(cd?.[1]) ?? normalizeRepoPath(cwd);
}

/** True when a captured command exited non-zero (a failure is not evidence / not landed work). */
function commandFailed(exitCode: number | null): boolean {
  return exitCode !== null && exitCode !== 0;
}

/** Changed files named inline on the commit's command (`git add A B`); heuristic. */
function commitFiles(args: string[]): string[] {
  const a = args.join(" ");
  const add = a.match(/git add\s+([^&|;]+)/);
  if (!add?.[1]) return [];
  return add[1]
    .split(/\s+/)
    .filter((t) => /\.[A-Za-z]/.test(t) && !t.startsWith("-"))
    .map((t) => basename(t));
}

type CommitRec = { repo: string; at: number; files: string[] };
type ReviewRec = {
  sessionId: string;
  endedAt: number | null;
  /** repo key -> what the review touched in it. */
  repos: Map<string, { examinedDiff: boolean; files: Set<string> }>;
};

const REVIEW_SOURCE = "codex-import"; // the cross-model reviewer vendor (v1)
const DEFAULT_WINDOW_HOURS = 24;

export type ReviewGapsInput = {
  paths: BasouPaths;
  /** ISO "now"; basis for `generatedAt`. */
  nowIso: string;
  /** Restrict to these repo keys (e.g. ["basou"]); omit/empty = every repo seen. */
  scope?: string[];
  /** Coarse pre-filter window before a commit to look for a review; default 24h. */
  windowHours?: number;
  onWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onSessionSkip?: (sessionId: string, reason: SessionSkipReason) => void;
};

/**
 * Compute the {@link ReviewGapsSummary} for a workspace. Read-only: reads
 * captured sessions / events and writes nothing.
 */
export async function findReviewGaps(input: ReviewGapsInput): Promise<ReviewGapsSummary> {
  const now = new Date(input.nowIso);
  const windowHours = input.windowHours ?? DEFAULT_WINDOW_HOURS;
  const scope = input.scope && input.scope.length > 0 ? input.scope : null;

  const loadOpts: Parameters<typeof loadSessionEntries>[1] = { now };
  if (input.onSessionSkip !== undefined) loadOpts.onSkip = input.onSessionSkip;
  if (input.onWarning !== undefined) loadOpts.onWarning = input.onWarning;
  const entries = await loadSessionEntries(input.paths, loadOpts);

  const reviews: ReviewRec[] = [];
  // committing session -> repo path -> commits
  const workUnits = new Map<string, Map<string, CommitRec[]>>();
  // committing session -> commit times whose repo/time could not be derived
  const unknownCommits = new Map<string, (number | null)[]>();

  for (const entry of entries) {
    const sessionDir = join(input.paths.sessions, entry.sessionId);
    const isReview = entry.session.session.source.kind === REVIEW_SOURCE;
    const reviewRepos = new Map<string, { examinedDiff: boolean; files: Set<string> }>();
    let reviewEnd: number | null = null;

    try {
      for await (const ev of replayEvents(sessionDir, {
        onWarning: (w) => input.onWarning?.(w, entry.sessionId),
      })) {
        if (ev.type !== "command_executed") continue;
        // A failed command is neither review evidence nor landed work.
        if (commandFailed(ev.exit_code)) continue;
        const at = Date.parse(ev.occurred_at);

        if (isReview) {
          // Bind to the repo the command actually ran in (an explicit `cd <repo>`
          // wins over cwd), symmetric with commit derivation, so `cd other &&
          // git diff` is not credited to the session's starting cwd.
          const repo = commandRepo(ev.args, ev.cwd);
          if (repo === null) continue;
          const ins = inspectCommand(ev.args);
          const slot = reviewRepos.get(repo) ?? { examinedDiff: false, files: new Set() };
          if (ins.examinedDiff) slot.examinedDiff = true;
          for (const f of ins.files) slot.files.add(f);
          reviewRepos.set(repo, slot);
          if (!Number.isNaN(at)) reviewEnd = reviewEnd === null ? at : Math.max(reviewEnd, at);
          continue;
        }

        // committing (code-author) session: collect git-commit events
        if (!ev.args.join(" ").includes("git commit")) continue;
        const repo = commandRepo(ev.args, ev.cwd);
        if (repo === null || Number.isNaN(at)) {
          // Surface as unknown rather than silently dropping an observed commit.
          const list = unknownCommits.get(entry.sessionId) ?? [];
          list.push(Number.isNaN(at) ? null : at);
          unknownCommits.set(entry.sessionId, list);
          continue;
        }
        const byRepo = workUnits.get(entry.sessionId) ?? new Map<string, CommitRec[]>();
        const list = byRepo.get(repo) ?? [];
        list.push({ repo, at, files: commitFiles(ev.args) });
        byRepo.set(repo, list);
        workUnits.set(entry.sessionId, byRepo);
      }
    } catch {
      input.onSessionSkip?.(entry.sessionId, "events_jsonl_unreadable");
      continue;
    }

    if (isReview && reviewRepos.size > 0) {
      reviews.push({ sessionId: entry.sessionId, endedAt: reviewEnd, repos: reviewRepos });
    }
  }

  const windowMs = windowHours * 3600 * 1000;
  const units: ReviewGapUnit[] = [];
  let newestCommit: number | null = null;

  for (const [sessionId, byRepo] of workUnits) {
    for (const [repoPath, commits] of byRepo) {
      const label = basename(repoPath);
      if (scope !== null && !scope.includes(label)) continue;
      const times = commits.map((c) => c.at).sort((a, b) => a - b);
      const first = times[0] ?? null;
      const last = times[times.length - 1] ?? null;
      if (last !== null) newestCommit = newestCommit === null ? last : Math.max(newestCommit, last);
      const changedFiles = new Set(commits.flatMap((c) => c.files));

      // candidate reviews: the SAME repo path (collision-safe), ended before this
      // unit's first commit, within the coarse window. The window is only a
      // pre-filter — binding is by examined diff / overlapping files, never by
      // temporal proximity alone.
      const before = first ?? last ?? 0;
      const nearby = reviews.filter((r) => {
        if (!r.repos.has(repoPath) || r.endedAt === null) return false;
        return r.endedAt <= before && r.endedAt >= before - windowMs;
      });
      const bound = nearby.filter((r) => {
        const touched = r.repos.get(repoPath);
        if (touched === undefined) return false;
        if (touched.examinedDiff) return true;
        for (const f of changedFiles) if (touched.files.has(f)) return true;
        return false;
      });

      const verdict: ReviewGapVerdict =
        bound.length > 0 ? "candidate" : nearby.length > 0 ? "near_unbound" : "omission";
      const cited = verdict === "candidate" ? bound : verdict === "near_unbound" ? nearby : [];

      units.push({
        repo: label,
        sessionId,
        commitCount: commits.length,
        firstCommitAt: first === null ? null : new Date(first).toISOString(),
        lastCommitAt: last === null ? null : new Date(last).toISOString(),
        verdict,
        reviews: cited.map((r) => ({
          sessionId: r.sessionId,
          examinedDiff: r.repos.get(repoPath)?.examinedDiff ?? false,
          files: [...(r.repos.get(repoPath)?.files ?? [])].slice(0, 8),
          endedAt: r.endedAt === null ? null : new Date(r.endedAt).toISOString(),
        })),
      });
    }
  }

  // Observed commits whose repo/time could not be derived become explicit
  // `unknown` units (an abstention, never a clear). They cannot be attributed to
  // a scoped repo, so they are reported only when no `--repo` scope is applied.
  if (scope === null) {
    for (const [sessionId, times] of unknownCommits) {
      const valid = times.filter((t): t is number => t !== null).sort((a, b) => a - b);
      const first = valid[0] ?? null;
      const last = valid[valid.length - 1] ?? null;
      if (last !== null) newestCommit = newestCommit === null ? last : Math.max(newestCommit, last);
      units.push({
        repo: "(unknown)",
        sessionId,
        commitCount: times.length,
        firstCommitAt: first === null ? null : new Date(first).toISOString(),
        lastCommitAt: last === null ? null : new Date(last).toISOString(),
        verdict: "unknown",
        reviews: [],
      });
    }
  }

  const recentFirst = (a: ReviewGapUnit, b: ReviewGapUnit): number =>
    (Date.parse(b.lastCommitAt ?? "") || 0) - (Date.parse(a.lastCommitAt ?? "") || 0);

  const repoKeys = [...new Set(units.map((u) => u.repo))].sort();
  const repos: ReviewGapRepoSummary[] = repoKeys.map((repo) => {
    const us = units.filter((u) => u.repo === repo);
    return {
      repo,
      units: us.length,
      omissionUnits: us.filter((u) => u.verdict === "omission").length,
      nearUnboundUnits: us.filter((u) => u.verdict === "near_unbound").length,
      candidateUnits: us.filter((u) => u.verdict === "candidate").length,
      unknownUnits: us.filter((u) => u.verdict === "unknown").length,
    };
  });

  return {
    generatedAt: input.nowIso,
    windowHours,
    scope,
    repos,
    gaps: units
      .filter((u) => u.verdict === "omission" || u.verdict === "near_unbound")
      .sort(recentFirst),
    candidates: units.filter((u) => u.verdict === "candidate").sort(recentFirst),
    unknowns: units.filter((u) => u.verdict === "unknown").sort(recentFirst),
    newestCommitAt: newestCommit === null ? null : new Date(newestCommit).toISOString(),
  };
}
