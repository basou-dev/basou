import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { loadSessionEntries, type SessionSkipReason } from "../storage/sessions.js";
import { deriveCommandWorkdir } from "./command-workdir.js";

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
 * but it NEVER changes that unit's verdict — a gap stays a gap, a candidate
 * stays a candidate — otherwise an empty record would become a way to make the
 * gap count go down. It re-labels; it does not clear.
 *
 * The Stop review gate takes such a self-report at face value and goes quiet on
 * it. That is a settled difference in contract, not a lapse there and rigour
 * here. This surfacer answers a question about the RECORD — across everything
 * captured, what still looks unreviewed — so a claim it cannot corroborate must
 * not move the answer. The gate answers a question about ONE turn, while that
 * turn is ending, with only that turn's transcript to read: there the
 * self-report is the only evidence in existence. Declining it would not hang a
 * session — the loop guard keeps a continuation turn silent — but it would put
 * a reminder on every shipping turn regardless of what that session did, which
 * is a reminder a person stops reading.
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
 * What was edited between a self-report and the work it was paired with, split
 * by whether one of that record's own findings named the file.
 *
 * The shape this exists to surface: a review runs, one of its findings changes
 * the DESIGN, the new implementation is written, and that implementation ships
 * without anyone reviewing the thing that actually shipped. The record is
 * truthful — a review did run — and is exactly why the miss is invisible: what
 * it covered is not what landed.
 *
 * Like every other self-report label, this NEVER changes the unit's verdict. It
 * can only add suspicion to a record, never take it away: a record with no
 * unnamed edit is not thereby corroborated, it has merely failed to raise this
 * particular flag.
 */
export type EditsAfterRecord = {
  /** Repo-relative paths in the window that no finding named (capped for display). */
  unnamed: string[];
  /** Distinct unnamed paths, before the display cap. */
  unnamedCount: number;
  /** Distinct edited paths a finding DID name — the "applied the findings" case. */
  namedCount: number;
  /**
   * The record carried at least one `findings[].location` to compare against.
   * When false nothing COULD be named, so `unnamedCount` says only that files
   * were edited — not that they were files the review never looked at.
   */
  hasFindingLocations: boolean;
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
  /**
   * Files edited after this record was written and before the paired unit's
   * last commit. See {@link EditsAfterRecord}.
   */
  editsAfterRecord: EditsAfterRecord;
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
  /**
   * How many of this unit's commits ran with no recorded exit code, so that the
   * commit landing is assumed rather than observed.
   *
   * A caveat, never an input to `verdict`: lowering the count would mean an
   * unverifiable commit could quietly leave the report, which is the same hole
   * a self-report must not open. `commitCount` still counts every commit.
   */
  commitsWithUnobservedOutcome: number;
};

/** Recorded reviews that reached no unit of work, broken down by cause. */
export type UnattachedSelfReports = {
  total: number;
  /** The record named no repository at all. */
  noRepos: number;
  /**
   * At least one repository it named could not be verified as a repo root on
   * this machine. ANY unverifiable entry puts the record here, even alongside
   * one that resolved: a half-checkable claim is refused whole, so that
   * everything that does get paired was checkable in full.
   */
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
   * Units carrying a self-report that was followed, before the commit, by an
   * edit to a file none of that record's findings named.
   *
   * Reported as its own number rather than folded into the gap count, because
   * it answers a different question. A gap asks whether a review happened at
   * all; this asks whether the review that happened looked at what shipped. A
   * unit can be a `candidate` — trail and all — and still be counted here.
   */
  unitsWithEditsAfterRecord: number;
  /**
   * `file_changed` events whose path named no placeable location, so they could
   * not be considered for {@link EditsAfterRecord} in any repository.
   *
   * Reported because the alternative is silence that reads as a clean result: a
   * repo-relative path (the shape the git capability writes) cannot be attributed
   * to a repository without guessing, and a store made mostly of them would
   * report no edits anywhere while looking exactly like a store that had none.
   */
  unplaceableEdits: number;
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
  if (/-workspace$/.test(seg) || s.includes("$")) return null;
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
 * The provenance cannot be recovered from the key afterwards: the string
 * fallback can land on a path that exists (collapsing `*-workspace` out of
 * `/x/foo-workspace/bar` gives `/x/bar`), so asking "does this key resolve?"
 * would answer yes about a key that was guessed from a directory name.
 */
function commandRepoWithProvenance(
  command: string | null,
  args: string[],
  cwd: string | null,
): { key: string | null; resolved: boolean } {
  const raw = commandRepoPath(command, args, cwd);
  if (raw === null) return { key: null, resolved: false };
  return { key: normalizeRepoPath(raw), resolved: resolveRepoRoot(raw) !== null };
}

/**
 * The path a command effectively ran in, or null when the captured line cannot
 * be read with certainty.
 *
 * An explicit `cd <target>` wins over cwd — and wins EVEN WHEN the target
 * resolves to null (a non-repo dir): the command ran there, so it must not be
 * silently re-credited to the session's cwd, which could falsely bind an
 * unrelated repo and clear a real gap. cwd is used only when the grammar
 * established that nothing moved; when it cannot tell, the answer is null and
 * the caller abstains.
 *
 * A `kind: "cwd"` answer over a null cwd abstains too: the grammar established
 * that the line did not move the shell, but the event never recorded WHERE the
 * shell was, so there is no directory to credit.
 */
function commandRepoPath(
  command: string | null,
  args: string[],
  cwd: string | null,
): string | null {
  const workdir = deriveCommandWorkdir(command, args, cwd);
  if (workdir.kind === "ambiguous") return null;
  return workdir.kind === "target" ? workdir.path : cwd;
}

/** Repo a command effectively ran in; null when it could not be read. */
function commandRepo(command: string | null, args: string[], cwd: string | null): string | null {
  return normalizeRepoPath(commandRepoPath(command, args, cwd));
}

/**
 * What a captured command's recorded outcome establishes.
 *
 * Three values, because `exit_code === null` is not a fourth spelling of
 * success: it means the outcome was never observed (the source recorded none, or
 * the child died by signal). A boolean `commandFailed` collapsed `unknown` into
 * "did not fail", so an unobserved `git commit` was counted as landed work and an
 * unobserved `git diff` as a review that happened.
 *
 * `unknown` does not stop the command being considered — refusing it would
 * discard most of the trail, since the claude-code transcript records no outcome
 * at all — but it must never be reported as established. The caller counts it so
 * the report can say which of its evidence is unverified, exactly as it does for
 * a self-reported review: the caveat is added, the gap count is not lowered.
 */
type CommandOutcome = "succeeded" | "failed" | "unknown";

function commandOutcome(exitCode: number | null): CommandOutcome {
  if (exitCode === null) return "unknown";
  return exitCode === 0 ? "succeeded" : "failed";
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
  /** The command's exit code was recorded, so "this commit landed" is observed rather than assumed. */
  outcomeObserved: boolean;
};
type ReviewRec = {
  sessionId: string;
  endedAt: number | null;
  /** repo key -> what the review touched in it. */
  repos: Map<string, { examinedDiff: boolean; files: Set<string> }>;
};
/**
 * One recorded file edit: when it happened, and where in BOTH spellings.
 *
 * Both are kept because the two sides of the comparison are not resolved the
 * same way. A repository key is realpath-resolved when the path is present, but
 * falls back to a string heuristic when it is not; an edit keeps whatever
 * spelling it was recorded with. Matching on only one of them misses the other
 * case.
 */
type EditRec = { at: number; raw: string; resolved: string };

/**
 * A recorded edit path resolved the way a repository key is: realpath the
 * longest existing ANCESTOR and re-append the segments that are missing, so a
 * file that has since moved still resolves the symlinks in the ancestry it had.
 *
 * Without this the feature is blind to an entire ordinary workflow. Work routed
 * through a workspace view is RECORDED through the view, while the repository it
 * commits to resolves past that symlink — measured on the dogfood store, 1119 of
 * 6135 recorded edits carry a view spelling, so close to a fifth of them. Compared
 * as written, every one of those reads as no edit at all, which is the single
 * direction this surfacer must never fail in.
 */
function resolveEditPath(abs: string): string {
  // NOT normalized first. `link/..` is `other` when `link` is a symlink and
  // `link`'s parent only lexically; collapsing it here decides that question
  // wrongly and silently, and the direction it fails in is suppression.
  let current = abs;
  const tail: string[] = [];
  // Bounded by path depth so a pathological input cannot loop.
  for (let guard = 0; guard < 4096; guard += 1) {
    const real = resolveRealpath(current);
    if (real !== null) return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    const parent = dirname(current);
    if (parent === current) return normalize(abs);
    tail.push(basename(current));
    current = parent;
  }
  return normalize(abs);
}

/**
 * A `findings[].location` reduced to the repo-relative path it points at.
 *
 * A location is written for a person to read, so it carries a line number
 * (`packages/core/x.ts:907`) or a trailing note naming a symbol
 * (`packages/core/x.ts (deriveCommandWorkdir)`). Both are stripped; a location
 * naming no path at all yields null.
 */
function findingPath(location: string): string | null {
  const s = location
    .trim()
    .replace(/\s*\(.*\)\s*$/, "")
    // One or more trailing position groups: `:12`, `:12-15`, `:12:3`. Stripping
    // only ONE leaves `src/a.ts:12` behind for a line-and-column location, and
    // that spelling matches no edited file, so the file the finding named is
    // then reported as one it never named.
    .replace(/(?::\d+(?:-\d+)?)+$/, "")
    .trim();
  if (s.length === 0) return null;
  // `src/../src/a.ts` and `src/a.ts` name one file; an unnormalized spelling on
  // either side of the comparison never matches the other.
  const n = normalize(s);
  return n.length === 0 || n === "." ? null : n;
}

/**
 * A recorded `file_changed` path as an absolute path, or null.
 *
 * The path sanitizer writes `~/…` for anything under the home directory and
 * leaves any other absolute path verbatim, so those two spellings are the whole
 * population. A repo-relative spelling cannot be placed without already knowing
 * which repository it belongs to, so it is dropped rather than guessed at.
 */
function absoluteEditPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const s = p.trim();
  // Kept as recorded (beyond expanding `~`): the dot segments in it are what
  // {@link resolveEditPath} needs in order to resolve them through the
  // filesystem rather than lexically.
  if (s.startsWith("~/")) return homedir() + s.slice(1);
  return isAbsolute(s) ? s : null;
}

/**
 * A `review_recorded` event reduced to what binding and display need.
 * `recordedAfterCommit` and `editsAfterRecord` are deliberately absent: both are
 * facts about a record PAIRED WITH a unit, not about the record, so they are
 * decided at attach time.
 */
type SelfReportRec = Omit<SelfReportedReview, "recordedAfterCommit" | "editsAfterRecord"> & {
  at: number;
  /** Normalized repo paths the record named; the only binding key it has. */
  repos: Set<string>;
  /** Repo-relative paths this record's own findings named. */
  findingPaths: Set<string>;
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
  const edits: EditRec[] = [];
  // file_changed events whose path could not be placed in any repository.
  let unplaceableEdits = 0;
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
          // EVERY named repository must verify, not merely one. A record naming
          // both a live and a vanished repository was pooled on the strength of
          // the live one, attached there, and the half it could not check went
          // unmentioned -- or, if the live half had no work, was reported as
          // "no work in the window", which is not what happened. Refusing the
          // record keeps the invariant that everything pooled is fully
          // checkable, and says so instead of half-saying it.
          const keys = named.map((r) => recordRepoKey(r));
          const repos = new Set(keys.filter((r): r is string => r !== null));
          if (keys.some((k) => k === null) || repos.size === 0 || Number.isNaN(recordedAt)) {
            // Name the mistake: an absent `repos` is the operator forgetting a
            // field, while a `repos` holding any path basou cannot check is a
            // wrong path. Only the first is what the record's own location
            // explains.
            if (named.length === 0) noRepos++;
            else unresolvableRepo++;
            continue;
          }
          const findingPaths = new Set<string>();
          for (const f of ev.findings ?? []) {
            const fp = f.location === undefined ? null : findingPath(f.location);
            if (fp !== null) findingPaths.add(fp);
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
            findingPaths,
          });
          continue;
        }
        // Every recorded edit, from EVERY session, kept as (when, where). The
        // records these will be compared against land in their own ad-hoc
        // sessions, and the work one covers may itself span sessions, so the
        // join is by time and repository rather than by session. Erring wide is
        // deliberate: an edit wrongly included adds suspicion to a record, and
        // adding suspicion is the direction this module is allowed to fail in.
        if (ev.type === "file_changed") {
          const editedAt = Date.parse(ev.occurred_at);
          const abs = absoluteEditPath(ev.path);
          if (Number.isNaN(editedAt)) continue;
          if (abs === null) {
            // A repo-relative spelling cannot be placed without knowing which
            // repository it belongs to, and guessing would attribute one
            // project's edit to another. It is COUNTED rather than dropped in
            // silence: the git capability writes exactly this shape, so a store
            // full of them would otherwise report "no edits" and read as a
            // clean result.
            unplaceableEdits++;
            continue;
          }
          edits.push({ at: editedAt, raw: abs, resolved: resolveEditPath(abs) });
          continue;
        }
        if (ev.type !== "command_executed") continue;
        // A command observed to FAIL is neither review evidence nor landed work.
        // One whose outcome was never observed is still considered — dropping it
        // would discard most of the trail — but it is carried as unverified.
        const outcome = commandOutcome(ev.exit_code);
        if (outcome === "failed") continue;
        const at = Date.parse(ev.occurred_at);

        if (isReview) {
          // Bind to the repo the command actually ran in (an explicit `cd <repo>`
          // wins over cwd), symmetric with commit derivation, so `cd other &&
          // git diff` is not credited to the session's starting cwd.
          const repo = commandRepo(ev.command, ev.args, ev.cwd);
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
        const { key: repo, resolved: keyResolved } = commandRepoWithProvenance(
          ev.command,
          ev.args,
          ev.cwd,
        );
        if (repo === null || Number.isNaN(at)) {
          // Surface as unknown rather than silently dropping an observed commit.
          const list = unknownCommits.get(entry.sessionId) ?? [];
          list.push(Number.isNaN(at) ? null : at);
          unknownCommits.set(entry.sessionId, list);
          continue;
        }
        const byRepo = workUnits.get(entry.sessionId) ?? new Map<string, CommitRec[]>();
        const list = byRepo.get(repo) ?? [];
        list.push({
          repo,
          at,
          files: commitFiles(ev.args),
          keyResolved,
          outcomeObserved: outcome === "succeeded",
        });
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
        selfReports: selfBound.map((r) =>
          toSelfReportedReview(r, r.at > earliest, editsAfterRecordFor(r, repoPath, latest, edits)),
        ),
        commitsWithUnobservedOutcome: commits.filter((c) => !c.outcomeObserved).length,
        reviews: cited.map((r) => ({
          sessionId: r.sessionId,
          examinedDiff: r.repos.get(repoPath)?.examinedDiff ?? false,
          files: [...(r.repos.get(repoPath)?.files ?? [])].slice(0, 8),
          endedAt: r.endedAt === null ? null : new Date(r.endedAt).toISOString(),
        })),
      });
    }
  }
  for (const [sessionId, times] of unknownCommits) {
    const valid = times.filter((t): t is number => t !== null).sort((a, b) => a - b);
    const first = valid[0] ?? null;
    const last = valid[valid.length - 1] ?? null;
    // Under a scope the footer speaks for the scoped repo, and an undeterminable
    // commit belongs to no repo: it must be listed as a caveat without silently
    // becoming that repo's "newest captured commit".
    if (last !== null && scope === null) {
      newestCommit = newestCommit === null ? last : Math.max(newestCommit, last);
    }
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
      // These commits were never placed in a repository, so the per-commit
      // outcome is not tracked for them; the unit is already a caveat.
      commitsWithUnobservedOutcome: 0,
    });
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

  // The tally is headed "By repository" and, under a scope, is read as being
  // about that repository. An undeterminable unit belongs to none, so it stays
  // out of the tally there -- it is listed in its own section instead.
  const talliedUnits = scope === null ? units : units.filter((u) => u.verdict !== "unknown");
  const repoKeys = [...new Set(talliedUnits.map((u) => u.repo))].sort();
  const repos: ReviewGapRepoSummary[] = repoKeys.map((repo) => {
    const us = talliedUnits.filter((u) => u.repo === repo);
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

  // Counted over EVERY unit, not only the gaps: a unit with a bound review
  // trail can still have shipped something that trail never saw.
  const unitsWithEditsAfterRecord = units.filter((u) =>
    u.selfReports.some((r) => r.editsAfterRecord.unnamedCount > 0),
  ).length;

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
    unitsWithEditsAfterRecord,
    unplaceableEdits,
    refusedPairings,
    newestCommitAt: newestCommit === null ? null : new Date(newestCommit).toISOString(),
  };
}

/** A unit with no bound review trail. Self-reports never move a unit out of this set. */
function isGap(u: ReviewGapUnit): boolean {
  return u.verdict === "omission" || u.verdict === "near_unbound";
}

/** How many unnamed paths a single record spells out before the rest are counted. */
const UNNAMED_EDITS_SHOWN = 5;

/**
 * Split the edits recorded between `r` and the unit's work by whether one of
 * `r`'s own findings named the file.
 *
 * The window opens strictly AFTER the record: an edit made while the review was
 * being written is part of what it was looking at. It closes at the unit's LAST
 * commit rather than its first, because every commit in the unit is work this
 * record is being read as covering — closing at the first would let everything
 * after it ship uncounted.
 *
 * Membership in the repository is by path prefix on the unit's own key, which
 * is a canonical root. A record's finding locations are repo-relative and an
 * edit is absolute, so the edit is reduced to the same spelling before the two
 * are compared; without that step nothing would ever match and this would
 * silently report every edit as unnamed.
 */
function editsAfterRecordFor(
  r: SelfReportRec,
  repoPath: string,
  lastCommitAt: number,
  edits: readonly EditRec[],
): EditsAfterRecord {
  const prefix = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
  // One entry per edited file: the spelling to SHOW, and every spelling that
  // file is known by. Both sides matter and for different reasons. Membership
  // needs either, because a resolved repository key needs the resolved edit
  // while a key that fell back to the string heuristic needs the raw one.
  // Matching a finding needs either too: a finding may name the alias
  // (`src/alias.ts`) that the resolved spelling has already replaced with its
  // target, and comparing only the target accuses the record of failing to name
  // a file it named exactly.
  const byFile = new Map<string, Set<string>>();
  for (const e of edits) {
    if (e.at <= r.at || e.at > lastCommitAt) continue;
    const spellings = new Set<string>();
    if (e.resolved.startsWith(prefix)) spellings.add(e.resolved.slice(prefix.length));
    // The raw spelling is kept as a second name for the same file, because a
    // finding may name the ALIAS (`src/alias.ts`) that resolution has already
    // replaced with its target (`src/real.ts`). Comparing only the target
    // accuses the record of failing to name a file it named exactly.
    // Kept literal. Normalising it here changes nothing that can be observed:
    // when resolution placed the file its spelling is already canonical, and
    // when it did not, the fallback it returns is normalised too. The literal
    // form is the one a finding naming an alias is written in.
    if (e.raw.startsWith(prefix)) spellings.add(e.raw.slice(prefix.length));
    const display = [...spellings][0];
    if (display === undefined) continue;
    const slot = byFile.get(display) ?? new Set<string>();
    for (const sp of spellings) slot.add(sp);
    byFile.set(display, slot);
  }
  let namedCount = 0;
  const unnamed: string[] = [];
  for (const [display, spellings] of byFile) {
    if ([...spellings].some((sp) => r.findingPaths.has(sp))) namedCount++;
    else unnamed.push(display);
  }
  unnamed.sort();
  return {
    unnamed: unnamed.slice(0, UNNAMED_EDITS_SHOWN),
    unnamedCount: unnamed.length,
    namedCount,
    hasFindingLocations: r.findingPaths.size > 0,
  };
}

/** Drop the binding-only fields so the emitted record carries just the report. */
function toSelfReportedReview(
  r: SelfReportRec,
  recordedAfterCommit: boolean,
  editsAfterRecord: EditsAfterRecord,
): SelfReportedReview {
  return {
    sessionId: r.sessionId,
    eventId: r.eventId,
    reviewer: r.reviewer,
    target: r.target,
    recordedAt: r.recordedAt,
    commits: r.commits,
    recordedAfterCommit,
    editsAfterRecord,
  };
}
