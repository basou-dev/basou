import { resolve } from "node:path";
import type { ReplayWarning } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import type { TaskSkipReason } from "../storage/tasks.js";
import {
  BOARD_COMPONENTS_METHOD,
  type BoardComponent,
  byCodePoint,
  measureComponents,
} from "./components.js";
import { BOARD_DEFAULT_AT } from "./declaration.js";
import { BOARD_EFFORT_METHOD, type BoardEffort, measureEffort } from "./effort.js";
import {
  BOARD_FRESHNESS_METHOD,
  type BoardFreshness,
  type BoardImportProbe,
  measureFreshness,
} from "./freshness.js";
import { BOARD_INTEGRITY_METHOD, type BoardIntegrity, measureIntegrity } from "./integrity.js";
import type { BoardNotFound } from "./measure.js";
import { type BoardPageBody, effortOf } from "./page.js";
import { BOARD_REPOS_METHOD, type BoardRepo, measureRepos } from "./repos.js";
import {
  BOARD_REVIEW_GAPS_METHOD,
  type BoardReviewGaps,
  measureReviewGaps,
} from "./review-gaps.js";
import { openRepoScope, type RepoScopeResult } from "./scope.js";
import { BOARD_TRAIL_METHOD, type BoardTrail, readDecisions, trailSection } from "./trail.js";

/**
 * What can be measured of a workspace with no board declared: the built-in
 * sections of `basou board measure` that need nothing from a declaration,
 * measured as that command measures them. The effort starts on the day of
 * the first session, in this host's time zone; the components are the ones
 * the markers find, held against no registry. There is no axis, no measure
 * or ratio of a declaration, no digest and no diff: nothing here is recorded
 * or judged.
 */
export type BoardLiveMeasurement = {
  measured_at: string;
  measured_with: { basou: string; build: string | null };
  complete: boolean;
  not_found: BoardNotFound[];
  /** The version of how each section measures, as in a measurement of a declared board. */
  methods: {
    repos: number;
    trail: number;
    integrity: number;
    review_gaps: number;
    freshness: number;
    effort: number;
    components: number;
  };
  repos: BoardRepo[];
  trail: BoardTrail;
  integrity: BoardIntegrity;
  review_gaps: BoardReviewGaps;
  freshness: BoardFreshness;
  effort: BoardEffort;
  /** The components found, by key; null, with an entry at `components`, when they were not measured. */
  components: Record<string, BoardComponent["kinds"]> | null;
};

export type MeasureBoardLiveInput = {
  /** The absolute root the manifest's repo paths are relative to. */
  root: string;
  /** The paths of the manifest's repos, in its order. */
  repos: readonly string[];
  paths: BasouPaths;
  now: Date;
  measuredWith: { basou: string; build: string | null };
  onReplayWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onTaskSkip?: (taskId: string, reason: TaskSkipReason) => void;
  /** A dry run of `basou refresh`, to count the sessions not yet imported. */
  probeImports?: () => Promise<BoardImportProbe | null>;
};

/** Measure what a workspace shows with no board declared. Reads, never writes, and sends nothing. */
export async function measureBoardLive(
  input: MeasureBoardLiveInput,
): Promise<BoardLiveMeasurement> {
  const notFound: BoardNotFound[] = [];
  const scopes = new Map<string, Promise<RepoScopeResult>>();
  const worktreeOf = (repo: string): Promise<RepoScopeResult> => {
    let scope = scopes.get(repo);
    if (scope === undefined) {
      scope = openRepoScope(resolve(input.root, repo), BOARD_DEFAULT_AT);
      scopes.set(repo, scope);
    }
    return scope;
  };

  const repos = await measureRepos(input.repos, input.root, worktreeOf);
  notFound.push(...repos.notFound);
  const trailed = trailSection(await readDecisions(input));
  notFound.push(...trailed.notFound);
  const verified = await measureIntegrity(input.paths);
  notFound.push(...verified.notFound);
  const reviewed = await measureReviewGaps(input);
  notFound.push(...reviewed.notFound);
  const current = await measureFreshness(input);
  notFound.push(...current.notFound);
  const worked = await measureEffort({
    paths: input.paths,
    now: input.now,
    repos: input.repos,
    authorDates: repos.authorDates,
  });
  notFound.push(...worked.notFound);
  const built = await measureComponents({
    repos: input.repos,
    names: new Map(repos.repos.map((repo) => [repo.path, repo.name])),
    worktreeOf,
    registered: {},
  });
  notFound.push(...built.notFound);
  const { found } = built.components;

  return {
    measured_at: input.now.toISOString(),
    measured_with: input.measuredWith,
    complete: notFound.length === 0,
    not_found: notFound,
    methods: {
      repos: BOARD_REPOS_METHOD,
      trail: BOARD_TRAIL_METHOD,
      integrity: BOARD_INTEGRITY_METHOD,
      review_gaps: BOARD_REVIEW_GAPS_METHOD,
      freshness: BOARD_FRESHNESS_METHOD,
      effort: BOARD_EFFORT_METHOD,
      components: BOARD_COMPONENTS_METHOD,
    },
    repos: repos.repos,
    trail: trailed.trail,
    integrity: verified.integrity,
    review_gaps: reviewed.reviewGaps,
    freshness: current.freshness,
    effort: worked.effort,
    components:
      found === null
        ? null
        : Object.fromEntries(Object.entries(found).map(([key, c]) => [key, [...c.kinds]])),
  };
}

/** What the board page draws for a workspace measured now, with no record. */
export type BoardLivePage = {
  heading: { title: string; measured_at: string; complete: boolean; not_found: number };
  effort: BoardPageBody["effort"];
  repos: {
    path: string;
    name: string | null;
    head: string | null;
    branch: string | null;
    last_commit: string | null;
    commits: number | null;
    uncommitted: number | null;
    behind_main: number | null;
  }[];
  trail: BoardTrail;
  integrity: BoardIntegrity & {
    /** Every session counted in `by_status`, null when it was not measured. */
    sessions: number | null;
  };
  review_gaps: BoardReviewGaps;
  freshness: BoardFreshness;
  /** By key, in code point order; null when they were not measured. */
  components: { key: string; kinds: string[] }[] | null;
  footnotes: {
    not_found: BoardNotFound[];
    measured_with: { basou: string; build: string | null };
  };
};

/** Lay out a measurement of a workspace with no board for the board page. */
export function boardLivePage(title: string, m: BoardLiveMeasurement): BoardLivePage {
  const byStatus = m.integrity.by_status;
  return {
    heading: {
      title,
      measured_at: m.measured_at,
      complete: m.complete,
      not_found: m.not_found.length,
    },
    effort: effortOf(m.effort, []),
    repos: m.repos.map((r) => ({
      path: r.path,
      name: r.name,
      head: r.head,
      branch: r.branch,
      last_commit: r.last_commit,
      commits: r.commits,
      uncommitted: r.uncommitted,
      behind_main: r.behind_main,
    })),
    trail: m.trail,
    integrity: {
      ...m.integrity,
      sessions: byStatus === null ? null : Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    },
    review_gaps: m.review_gaps,
    freshness: m.freshness,
    components:
      m.components === null
        ? null
        : Object.keys(m.components)
            .sort(byCodePoint)
            .map((key) => ({ key, kinds: [...(m.components?.[key] ?? [])] })),
    footnotes: {
      not_found: m.not_found.map(({ at, reason }) => ({ at, reason })),
      measured_with: { basou: m.measured_with.basou, build: m.measured_with.build },
    },
  };
}
