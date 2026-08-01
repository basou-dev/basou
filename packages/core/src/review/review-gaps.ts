import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
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
 * A `review_recorded` event (written by `basou review record`) is a SELF-REPORT:
 * the agent's own claim that a review ran, with nothing corroborating it. Such a
 * record is bound to a unit by the repo paths it names and surfaced as a label,
 * but it NEVER changes a verdict and never leaves the gap list — otherwise an
 * empty record would become a way to make the count go down, the same weakness
 * the Stop-gate has. It re-labels; it does not clear.
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

/**
 * A `review_recorded` self-report bound to a unit by the repo paths it named.
 * Carries no corroboration: it is what the agent said it did, not what the
 * capture observed.
 */
export type SelfReportedReview = {
  sessionId: string;
  eventId: string;
  reviewer: string;
  target: string;
  recordedAt: string;
  /** Commit SHAs the record claimed to cover; display only, never a binding key. */
  commits: string[];
  /**
   * The record was written after this unit's first commit, so it cannot have
   * gated the work. Surfaced rather than hidden — a claim made after the fact is
   * still the operator's own note about what happened, and the label can never
   * reduce the gap count — but kept distinguishable, because when a record was
   * written is part of what the operator is judging.
   */
  recordedAfterCommit: boolean;
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
  /**
   * `review_recorded` self-reports naming this repo in the window. Present on
   * every repo-keyed unit; it re-labels the unit and NEVER alters `verdict`, so
   * a self-reported gap is still a gap.
   */
  selfReports: SelfReportedReview[];
};

/** Recorded reviews that reached no unit of work, broken down by cause. */
export type UnattachedSelfReports = {
  total: number;
  /** The record named no repository at all. */
  noRepos: number;
  /** It named repositories, but none resolved to a repo root on this machine. */
  unresolvableRepo: number;
  /** It named a resolvable repository, but no unit of work fell in the window. */
  noMatchingUnit: number;
  /**
   * Work WAS captured in the window, but the unit's own repository path could
   * not be verified, so the pairing could not be checked either way. Distinct
   * from {@link noMatchingUnit}, which would deny that the work exists.
   */
  unverifiableUnit: number;
};

export type ReviewGapRepoSummary = {
  repo: string;
  units: number;
  omissionUnits: number;
  nearUnboundUnits: number;
  candidateUnits: number;
  unknownUnits: number;
  /** Of the units with no bound trail, how many carry a self-report only. */
  selfReportedGapUnits: number;
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
  /**
   * Recorded reviews that changed nothing in this report — the answer to "I ran
   * `basou review record` and the omission is still there". Reported with the
   * reason for each, because basou must not assert a cause it has not
   * established; "no `repos` field" and "a `repos` that does not resolve" are
   * different mistakes with different fixes.
   *
   * Unlike {@link unknowns} this is NOT suppressed under a `--repo` scope, and
   * attachment is computed against every unit rather than the scoped ones. It is
   * a caveat about the tool's own input handling, not repo-dimensioned data, and
   * a completeness caveat that disappears under a filter is how silence starts
   * looking like success again — the very failure this surfacer exists to catch.
   */
  unattachedSelfReports: UnattachedSelfReports;
  /**
   * How many (record, unit) pairings fell inside a unit's window but could not
   * be checked, because that unit's own repository path was never verified.
   *
   * Counted per PAIRING, not per record, and reported even when the record
   * attached to some other unit: {@link unattachedSelfReports} only speaks for
   * records that changed nothing at all, so a record that landed once and was
   * refused elsewhere would otherwise leave the refusal invisible.
   */
  refusedPairings: number;
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
 * Per-process cache of realpath resolutions. A stored `null` records that
 * realpath FAILED for that input (the path is absent), so a repeat lookup of the
 * same absent path neither re-issues the syscall nor is mistaken for a cache
 * miss. The filesystem is assumed stable for the duration of a single command
 * run. Bounded in practice: one entry per distinct repo path seen (O(10–100)).
 */
const realpathCache = new Map<string, string | null>();

/** realpath an absolute path, caching both success and failure; null when unresolvable. */
function resolveRealpath(absPath: string): string | null {
  // Stored values are `string | null`; only an ABSENT key reads back as
  // `undefined`, so a cached failure (null) returns without re-issuing realpath.
  const cached = realpathCache.get(absPath);
  if (cached !== undefined) return cached;
  let resolved: string | null;
  try {
    resolved = realpathSync(absPath);
  } catch {
    resolved = null;
  }
  realpathCache.set(absPath, resolved);
  return resolved;
}

/** Per-process cache of git-repo-root checks, keyed by resolved (realpath) path. */
const repoRootCache = new Map<string, boolean>();

/**
 * Whether a resolved path is a git repo root, i.e. contains a `.git` (a directory
 * for a normal clone, a file for a worktree/submodule). Used to reject a real but
 * non-repo directory (a workspace view root, `/tmp`, a scratch dir) so it never
 * becomes a binding key. A bare repo (no working tree, no `.git` child) is not
 * recognized — review-gaps tracks working-tree commits, which bare repos lack.
 */
function isRepoRoot(realPath: string): boolean {
  const cached = repoRootCache.get(realPath);
  if (cached !== undefined) return cached;
  const result = existsSync(join(realPath, ".git"));
  repoRootCache.set(realPath, result);
  return result;
}

/**
 * Normalize a path to a stable BINDING key: the canonical full path (NOT just a
 * basename), so a commit in `/u/projects/basou` and a review in
 * `/u/projects/basou` bind, while a same-named checkout elsewhere
 * (`/tmp/x/basou`) does not.
 *
 * A workspace "view" reaches sibling repos through symlinks
 * (`<view>/<repo> -> ../<repo>`), and commits are often run with
 * `cd <view>/<repo>`. To collapse the view-routed path and the direct path to
 * one key REGARDLESS of the view directory's name, the path is resolved with
 * realpath (which also unifies platform aliases such as macOS `/tmp` ->
 * `/private/tmp`). Only absolute paths are resolved; a relative `cd ../x` target
 * would realpath against the wrong base, so it is left to the fallback.
 *
 * A resolved path is accepted as a key only when it is an actual git repo root
 * (contains `.git`); a real but non-repo directory (a view root, `/tmp`, a
 * scratch dir) returns null so the caller abstains (`unknown`) rather than
 * mislabeling it a repo. When realpath cannot resolve the path (e.g. a historical
 * capture whose repo has since moved), it FALLS BACK to a string heuristic that
 * collapses a `*-workspace`-named view and rejects the view root itself. Returns
 * null for a non-repo / view root, an unexpanded shell var, or empty input.
 *
 * The realpath / `.git` probes are the only filesystem I/O this otherwise
 * string-pure key function performs, and their results are cached for the
 * process lifetime.
 */
export function normalizeRepoPath(p: string | null | undefined): string | null {
  if (!p) return null;
  let s = stripQuotes(p.trim()).replace(/\/+$/, "");
  if (s.length === 0 || s === "~") return null;
  // expand a leading ~ so the same repo recorded as `~/projects/x` and
  // `/Users/u/projects/x` collapses to one binding key (the events capture both).
  if (s.startsWith("~/")) s = homedir() + s.slice(1);
  // An unexpanded variable ANYWHERE makes this a template, not a location:
  // `$ROOT/app` held different values in different sessions, so keying it
  // literally would collapse unrelated repositories onto one key. Checking only
  // the final segment missed exactly that shape.
  if (s.includes("$")) return null;

  // Prefer the on-disk truth: realpath follows the view's symlink so ANY view
  // name (not only `*-workspace`) collapses to the real repo path. Only absolute
  // paths are resolved; a relative target would resolve against the wrong base.
  if (isAbsolute(s)) {
    const real = resolveRealpath(s);
    if (real !== null) {
      // Resolved on disk: bind only when it is an actual git repo root. A real
      // but non-repo directory must not become a key, and must NOT fall through
      // to the string heuristic (which would mislabel `/tmp`, scratch dirs, a
      // view root) — abstain (null -> `unknown`) instead.
      return isRepoRoot(real) ? real : null;
    }
    // real === null: path absent (e.g. a moved/historical capture) -> fall
    // through to the legacy *-workspace string heuristic below.
  }

  // Fallback for paths not present on disk (historical/imported captures): the
  // legacy string heuristic, name-bound to `*-workspace` views.
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
 * A key for a path named by a RECORD: only a repository that is present on this
 * machine right now, resolved to its canonical root.
 *
 * This is deliberately narrower than the key a commit gets. A commit's path was
 * OBSERVED by basou at the moment the command ran, so when the repository has
 * since moved, the recorded path is still the best evidence of where the work
 * happened and keeps its string fallback. A record's path is a claim about
 * where a review looked, and pairing it with work by string resemblance alone —
 * when nothing on disk can confirm the two name the same repository — is a
 * guess. `review-gaps` exists because guesses about whether a protocol was
 * followed are worse than an admission of ignorance, so an unverifiable record
 * is reported as unverifiable rather than bound.
 *
 * What this rules out, by construction rather than by patching: a relative
 * spelling colliding with an unrelated `cd ../app`, a record and a commit
 * disagreeing about a symlink whose target has vanished, and a moved repository
 * pairing on a coincidence of spelling.
 */
function recordRepoKey(p: string): string | null {
  return resolveRepoRoot(p);
}

/** Why a hand-typed repository path cannot become a binding key. */
export type RepoPathProblem = "relative" | "absent" | "not_a_repo_root";

/** A `repos` entry that cannot bind, and why. */
export type UnbindableRepo = { repo: string; index: number; problem: RepoPathProblem };

/**
 * Strict repo-root resolution for HAND-TYPED input (a record's `repos`), as
 * opposed to {@link normalizeRepoPath}, which reads paths basou itself captured.
 *
 * The difference is the string fallback. `normalizeRepoPath` keeps one for
 * captured data: a historical `cd` target whose repo has since moved is still
 * the best key available, and refusing it would lose an observation basou
 * genuinely made. Typed input has no such claim on the benefit of the doubt — a
 * relative path, a typo, or a subdirectory would mint a key that no commit can
 * ever match, and the record would then be accepted, stored, and silently
 * unbindable forever. So this verifies against the disk and returns null
 * otherwise.
 *
 * The asymmetry runs the safe way: everything this accepts, `normalizeRepoPath`
 * resolves to the same key, so a record the writer took is a record the reader
 * can bind.
 */
export function resolveRepoRoot(p: string | null | undefined): string | null {
  return classifyRepoPath(p).resolved;
}

/** Resolve a hand-typed repo path, naming the reason when it cannot bind. */
function classifyRepoPath(p: string | null | undefined): {
  resolved: string | null;
  problem: RepoPathProblem | null;
} {
  let s = stripQuotes((p ?? "").trim()).replace(/\/+$/, "");
  if (s.startsWith("~/")) s = homedir() + s.slice(1);
  if (s.length === 0 || !isAbsolute(s)) return { resolved: null, problem: "relative" };
  const real = resolveRealpath(s);
  if (real === null) return { resolved: null, problem: "absent" };
  if (!isRepoRoot(real)) return { resolved: null, problem: "not_a_repo_root" };
  return { resolved: real, problem: null };
}

/**
 * The `repos` entries that could never bind to a unit of work, for the writer to
 * reject before the record is stored. Sharing {@link classifyRepoPath} with the
 * reader is the point: the writer must not accept a path the reader cannot use.
 */
export function findUnbindableRepos(repos: readonly string[]): UnbindableRepo[] {
  const out: UnbindableRepo[] = [];
  // Carries the INDEX rather than letting the caller look the value back up:
  // two identical bad entries are two distinct problems, and a value lookup
  // would report the first position twice and never name the second.
  repos.forEach((repo, index) => {
    const { problem } = classifyRepoPath(repo);
    if (problem !== null) out.push({ repo, index, problem });
  });
  return out;
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

/**
 * Repo a command effectively ran in, with whether that key was RESOLVED against
 * the disk or produced by the string fallback.
 *
 * The provenance cannot be recovered from the key afterwards. A fallback key is
 * not necessarily a path that fails to resolve: collapsing a `*-workspace`
 * segment out of `/x/foo-workspace/bar` yields `/x/bar`, which may well exist.
 * Asking "does this key resolve?" would then answer yes about a key that was
 * guessed from a directory NAME, so the question has to be answered where the
 * key is made.
 */
function commandRepoWithProvenance(
  args: string[],
  cwd: string,
): { key: string | null; resolved: boolean } {
  const raw = commandRepoPath(args, cwd);
  if (raw === null) return { key: null, resolved: false };
  return { key: normalizeRepoPath(raw), resolved: resolveRepoRoot(raw) !== null };
}

/**
 * The path a command effectively ran in, as an absolute location wherever the
 * capture allows one.
 *
 * An explicit `cd <target> &&` wins over cwd — and wins EVEN WHEN the target
 * resolves to nothing: the command ran there, so it must not be silently
 * re-credited to the session's cwd (which could falsely bind an unrelated repo
 * and clear a real gap).
 *
 * A RELATIVE target is joined to the captured cwd, which is the base the shell
 * used. Left relative it would key as its own literal spelling, so `cd ../app`
 * run beside two different repositories would collapse to one key and pair
 * their work — the failure being a false `candidate`, the exact verdict this
 * surfacer must never produce by accident. `..` is folded textually, matching
 * how a shell resolves it against the logical path it was given.
 */
function commandRepoPath(args: string[], cwd: string): string | null {
  const line = args.join(" ");
  // `cd &&` with no argument means $HOME, which the capture does not record.
  if (/\bcd\s*&&/.test(line)) return null;
  const cd = line.match(/\bcd\s+("[^"]+"|'[^']+'|[^\s&]+)\s*&&/);
  if (!cd?.[1]) return cwd;
  const target = stripQuotes(cd[1].trim());
  // Forms whose meaning lives outside the captured text. `-` is $OLDPWD;
  // `~user` is another account's home; an unexpanded `$VAR` is whatever it held
  // at the time. Resolving any of them against cwd would mint a key -- `<cwd>/-`
  // -- that two unrelated sessions can share, and a shared key here produces a
  // false CANDIDATE. Abstain instead: an underivable repo becomes `unknown`.
  if (target === "-" || target.includes("$")) return null;
  if (target.startsWith("~") && !target.startsWith("~/")) return null;
  if (target.startsWith("~/") || isAbsolute(target)) return target;
  // A relative target is only meaningful against an ABSOLUTE captured cwd. The
  // importers fall back to "." when the shell's directory was not recorded, and
  // joining to that would resolve against whatever directory `review-gaps`
  // happens to run in -- crediting the work to a repository next door.
  if (!isAbsolute(cwd)) return null;
  return resolve(cwd, target);
}

/** Repo a command effectively ran in: an explicit `cd <repo> &&` wins over cwd. */
function commandRepo(args: string[], cwd: string): string | null {
  const raw = commandRepoPath(args, cwd);
  return raw === null ? null : normalizeRepoPath(raw);
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

type CommitRec = {
  repo: string;
  at: number;
  files: string[];
  /** The key came from resolving the path on disk, not from the string fallback. */
  keyResolved: boolean;
};
type ReviewRec = {
  sessionId: string;
  endedAt: number | null;
  /** repo key -> what the review touched in it. */
  repos: Map<string, { examinedDiff: boolean; files: Set<string> }>;
};
/**
 * A `review_recorded` event reduced to what binding and display need.
 * `recordedAfterCommit` is deliberately absent: it is a fact about a record
 * PAIRED WITH a unit, not about the record, so it is decided at attach time.
 */
type SelfReportRec = Omit<SelfReportedReview, "recordedAfterCommit"> & {
  at: number;
  /** Normalized repo paths the record named; the only binding key it has. */
  repos: Set<string>;
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
  const selfReports: SelfReportRec[] = [];
  // Records rejected before they ever reach the binding step, by cause.
  let noRepos = 0;
  let unresolvableRepo = 0;
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
        // A self-reported review. Collected from ANY session (the record lands
        // in an ad-hoc session, not a vendor-imported one), and bound only by
        // the repo paths it names — the ad-hoc session's own location is the
        // planning repo, which would bind the wrong repo entirely.
        if (ev.type === "review_recorded") {
          const recordedAt = Date.parse(ev.occurred_at);
          // Prefer what the paths resolved to when the record was written: the
          // author's spelling can be a symlink retargeted since. Older records
          // predate the field and fall back to their `repos`. A PRESENT BUT
          // EMPTY `repos_resolved` must not shadow a populated `repos` — the
          // writer never emits that shape, but an imported event may carry it.
          const named =
            ev.repos_resolved !== undefined && ev.repos_resolved.length > 0
              ? ev.repos_resolved
              : (ev.repos ?? []);
          const repos = new Set(
            named.map((r) => recordRepoKey(r)).filter((r): r is string => r !== null),
          );
          if (repos.size === 0 || Number.isNaN(recordedAt)) {
            // Name the mistake: an absent `repos` is the operator forgetting a
            // field, a `repos` naming nothing verifiable is a path basou cannot
            // check. Only the first is what the record's own location explains.
            if (named.length === 0) noRepos++;
            else unresolvableRepo++;
            continue;
          }
          selfReports.push({
            sessionId: entry.sessionId,
            eventId: ev.id,
            reviewer: ev.reviewer,
            target: ev.target,
            recordedAt: ev.occurred_at,
            commits: ev.commits ?? [],
            at: recordedAt,
            repos,
          });
          continue;
        }
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
        const { key: repo, resolved: keyResolved } = commandRepoWithProvenance(ev.args, ev.cwd);
        if (repo === null || Number.isNaN(at)) {
          // Surface as unknown rather than silently dropping an observed commit.
          const list = unknownCommits.get(entry.sessionId) ?? [];
          list.push(Number.isNaN(at) ? null : at);
          unknownCommits.set(entry.sessionId, list);
          continue;
        }
        const byRepo = workUnits.get(entry.sessionId) ?? new Map<string, CommitRec[]>();
        const list = byRepo.get(repo) ?? [];
        list.push({ repo, at, files: commitFiles(ev.args), keyResolved });
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
  // Event ids of records that reached at least one unit ANYWHERE. Collected
  // across every unit, including those a `--repo` scope excludes, so a beta
  // record is never reported as "matched nothing" merely because the operator
  // scoped the report to alpha.
  const attachedSelfReports = new Set<string>();
  // Records that DID fall in a unit's window but were refused because the
  // unit's own repository could not be verified.
  const refusedForUnit = new Set<string>();
  // Per PAIRING, so a record that attached elsewhere still reports its refusals.
  let refusedPairings = 0;

  for (const [sessionId, byRepo] of workUnits) {
    for (const [repoPath, commits] of byRepo) {
      const label = basename(repoPath);
      const times = commits.map((c) => c.at).sort((a, b) => a - b);
      const first = times[0] ?? null;
      const last = times[times.length - 1] ?? null;

      // Self-reports naming this repo, within the window on EITHER side of the
      // unit. Computed before the scope filter so attachment is global.
      //
      // A record written after the commit is attached too, but flagged. It
      // cannot have gated the work, yet `occurred_at` is when basou persisted
      // the record, not when the review ran — a review at 09:55, a commit at
      // 10:00 and a record at 10:01 is an ordinary sequence. Hiding it would
      // discard the operator's own note to avoid a misreading the label already
      // prevents: the unit keeps its verdict and stays in the count either way.
      const earliest = first ?? last ?? 0;
      const latest = last ?? first ?? 0;
      // BOTH sides must name a repository that is here. A record key is always
      // a resolved root; a unit's key qualifies only when the commits' own paths
      // resolved. Re-resolving `repoPath` would not do: the string fallback can
      // land on a path that exists (collapsing `*-workspace` out of
      // `/x/foo-workspace/bar` gives `/x/bar`), and it reached it by guessing
      // from a directory name, which is what this rule refuses.
      //
      // EVERY commit, not some: one resolved commit does not vouch for a sibling
      // whose own path was guessed at. They share a key, but that is what is in
      // question — a claim would then cover work whose origin is unverified.
      const unitRepoIsHere = commits.every((c) => c.keyResolved);
      const inWindow = selfReports.filter(
        (r) => r.repos.has(repoPath) && r.at >= earliest - windowMs && r.at <= latest + windowMs,
      );
      const selfBound = unitRepoIsHere ? inWindow : [];
      // Refused for the unit's sake, not for want of work. Kept apart so the
      // report does not go on to deny that this unit exists.
      if (!unitRepoIsHere) {
        refusedPairings += inWindow.length;
        for (const r of inWindow) refusedForUnit.add(r.eventId);
      }
      for (const r of selfBound) attachedSelfReports.add(r.eventId);

      if (scope !== null && !scope.includes(label)) continue;
      if (last !== null) newestCommit = newestCommit === null ? last : Math.max(newestCommit, last);
      const changedFiles = new Set(commits.flatMap((c) => c.files));

      // candidate reviews: the SAME repo path (collision-safe), ended before this
      // unit's first commit, within the coarse window. The window is only a
      // pre-filter — binding is by examined diff / overlapping files, never by
      // temporal proximity alone. Unlike a self-report this stays one-sided: a
      // captured review session is evidence of gating, and evidence that only
      // exists after the commit is not evidence of it.
      const nearby = reviews.filter((r) => {
        if (!r.repos.has(repoPath) || r.endedAt === null) return false;
        return r.endedAt <= earliest && r.endedAt >= earliest - windowMs;
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
        // Attached after the verdict is computed, and deliberately not an input
        // to it: a record must never move a unit out of `gaps`.
        selfReports: selfBound.map((r) => toSelfReportedReview(r, r.at > earliest)),
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
        // No repo key, so nothing a record's `repos` could bind to.
        selfReports: [],
      });
    }
  }

  // Everything pooled resolved to a live repository root. A record that reached
  // nothing either fell in a unit's window and was refused because that unit's
  // repository could not be verified, or found no work at all. Reporting the
  // first as the second would deny that a captured unit exists.
  const missed = selfReports.filter((r) => !attachedSelfReports.has(r.eventId));
  const unverifiableUnit = missed.filter((r) => refusedForUnit.has(r.eventId)).length;
  const noMatchingUnit = missed.length - unverifiableUnit;

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
      selfReportedGapUnits: us.filter((u) => isGap(u) && u.selfReports.length > 0).length,
    };
  });

  return {
    generatedAt: input.nowIso,
    windowHours,
    scope,
    repos,
    gaps: units.filter(isGap).sort(recentFirst),
    candidates: units.filter((u) => u.verdict === "candidate").sort(recentFirst),
    unknowns: units.filter((u) => u.verdict === "unknown").sort(recentFirst),
    unattachedSelfReports: {
      total: noRepos + unresolvableRepo + noMatchingUnit + unverifiableUnit,
      noRepos,
      unresolvableRepo,
      noMatchingUnit,
      unverifiableUnit,
    },
    refusedPairings,
    newestCommitAt: newestCommit === null ? null : new Date(newestCommit).toISOString(),
  };
}

/** A unit with no bound review trail. Self-reports never move a unit out of this set. */
function isGap(u: ReviewGapUnit): boolean {
  return u.verdict === "omission" || u.verdict === "near_unbound";
}

/** Drop the binding-only fields so the emitted record carries just the report. */
function toSelfReportedReview(r: SelfReportRec, recordedAfterCommit: boolean): SelfReportedReview {
  return {
    sessionId: r.sessionId,
    eventId: r.eventId,
    reviewer: r.reviewer,
    target: r.target,
    recordedAt: r.recordedAt,
    commits: r.commits,
    recordedAfterCommit,
  };
}
