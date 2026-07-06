/**
 * Wiring drift for `basou project check`: given the gathered instruction-file
 * facts for every declared repo AND the workspace view, classify what is DRIFTED
 * from basou's native hub-and-spoke topology — an ABSENT instruction canonical
 * (AGENTS.md), an incompletely wired repo/view, an existing file/link that is not
 * what basou would wire, a canonical-name collision, or an unreachable repo.
 *
 * The motivating gap: `project check` compared only the roster against the
 * capture config (`source_roots`) and did no filesystem probe, so a MISSING
 * instruction canonical — most sharply the workspace view's own AGENTS.md — went
 * unnoticed until an operator eyeballed it. This makes `check` surface that class
 * as drift, leading with canonical absence (the missing-AGENTS.md case).
 *
 * Pure: it composes {@link summarizeSymlinkPlan} (which already judges the repo
 * side) with the view's gathered facts and re-frames both as read-only drift. The
 * realpath / symlink reading that produces the facts is the caller's job (the CLI
 * reuses the same gatherers `project symlinks` uses), so this stays testable
 * without disk I/O.
 */

import type { InstructionSymlinkFact, RepoSymlinkFacts, SymlinkCollision } from "./symlinks.js";
import { summarizeSymlinkPlan } from "./symlinks.js";

/**
 * The workspace view's gathered instruction facts, structurally identical to the
 * CLI's `ViewSymlinksOutcome` so the CLI passes its gathered value straight
 * through. `no-view` = no `workspace.view` declared; `collision` = the view name
 * clashes with a roster repo's canonical; `missing-canonical` = the view's own
 * canonical (`agents/<viewName>/AGENTS.md`) is absent (the my-favorites case);
 * `gathered` = the canonical exists and each spoke's on-disk state was inspected.
 */
export type ViewWiringFacts =
  | { kind: "no-view" }
  | { kind: "collision"; viewName: string; repoPath: string }
  | { kind: "missing-canonical"; viewName: string }
  | { kind: "gathered"; viewName: string; files: InstructionSymlinkFact[] };

/**
 * An absent instruction canonical (AGENTS.md) — the primary drift this surfaces.
 * `repo-hub`: a `hub` repo's anchor canonical (`agents/<repo>/AGENTS.md`) is
 * missing; `repo-self`: a `self` repo's own committed AGENTS.md is missing;
 * `view`: the workspace view's canonical (`agents/<viewName>/AGENTS.md`) is
 * missing. `name` is the repo's roster path (repo targets) or the view name.
 */
export type MissingCanonical = {
  target: "repo-hub" | "repo-self" | "view";
  name: string;
};

/** A repo or the view whose canonical exists but whose spoke links are not all wired. */
export type IncompleteWiring = {
  target: "repo" | "view";
  /** Repo roster path, or the view name. */
  path: string;
  /** Instruction files still missing their link (e.g. "AGENTS.md", "CLAUDE.md"). */
  files: string[];
};

/** An existing file/link that is not what basou would wire — surfaced, never touched. */
export type WiringConflict = {
  target: "repo" | "view";
  /** Repo roster path, or the view name. */
  path: string;
  file: string;
  reason: "mismatch" | "occupied" | "blocked";
  /** The conflicting link's current target, present only when `reason` is `mismatch`. */
  actualTarget?: string;
};

/** Distinct repos (or view↔repo) resolving to the same `agents/<canonicalName>/AGENTS.md`. */
export type WiringCollision = {
  canonicalName: string;
  /** The colliding roster repo paths. */
  repos: string[];
  /** True when the workspace view is one side of the collision. */
  view?: boolean;
};

export type WiringDriftSummary = {
  /** Absent instruction canonicals (repo hub, repo self, or view) — the headline gap. */
  missingCanonicals: MissingCanonical[];
  /** Repos/view whose canonical exists but whose spoke links are not fully wired. */
  incompleteWiring: IncompleteWiring[];
  /** Existing links that are not what basou would wire (left untouched). */
  conflicts: WiringConflict[];
  /** Ambiguous canonical-name collisions (repo↔repo or view↔repo). */
  collisions: WiringCollision[];
  /**
   * Declared repos not present on this machine (unresolvable / not a usable git
   * repo). ADVISORY: expected on a partial checkout (a workspace declares N repos;
   * a given machine has a subset cloned), so it is reported but does NOT fail
   * `ok` — otherwise `check` would read chronically dirty on every partial
   * checkout and drown the actionable drift it exists to surface.
   */
  unreachable: string[];
  /**
   * True when there is no ACTIONABLE drift: no missing canonical, no incomplete
   * wiring, no conflict, no collision. `unreachable` is deliberately excluded (it
   * is advisory — see above), so a partial checkout with otherwise-correct wiring
   * is `ok`. A missing view/repo AGENTS.md, a mismatched link, or a collision all
   * deny `ok`.
   */
  ok: boolean;
};

/**
 * Compute the {@link WiringDriftSummary} from the per-repo instruction facts and
 * the view's gathered facts. The repo side is delegated to
 * {@link summarizeSymlinkPlan} (so its dedup, collision, and canonical-absence
 * judgments are reused verbatim) and re-labelled as drift; the view side is folded
 * in from {@link ViewWiringFacts}. Leads with `missingCanonicals` because an absent
 * AGENTS.md is the drift the caller most needs to see.
 */
export function summarizeWiringDrift(input: {
  repos: RepoSymlinkFacts[];
  view: ViewWiringFacts;
}): WiringDriftSummary {
  const plan = summarizeSymlinkPlan(input.repos);

  const missingCanonicals: MissingCanonical[] = [
    ...plan.missingCanonical.map((path): MissingCanonical => ({ target: "repo-hub", name: path })),
    ...plan.selfAgentsMissing.map(
      (path): MissingCanonical => ({ target: "repo-self", name: path }),
    ),
  ];

  const incompleteWiring: IncompleteWiring[] = plan.plans.map((p) => ({
    target: "repo" as const,
    path: p.path,
    files: p.toCreate.map((c) => c.name),
  }));

  const conflicts: WiringConflict[] = plan.conflicts.map((c) => ({
    target: "repo" as const,
    path: c.repo,
    file: c.file,
    reason: c.reason,
    ...(c.actualTarget !== undefined ? { actualTarget: c.actualTarget } : {}),
  }));

  const collisions: WiringCollision[] = plan.collisions.map((c: SymlinkCollision) => ({
    canonicalName: c.canonicalName,
    repos: c.repos,
  }));

  // Fold the view in. A view collision or missing canonical is reported like the
  // repo equivalents; a gathered view contributes its own missing spokes (as
  // incompleteWiring) and non-`correct`/`missing` states (as conflicts).
  const view = input.view;
  if (view.kind === "collision") {
    collisions.push({ canonicalName: view.viewName, repos: [view.repoPath], view: true });
  } else if (view.kind === "missing-canonical") {
    missingCanonicals.push({ target: "view", name: view.viewName });
  } else if (view.kind === "gathered") {
    const missingSpokes: string[] = [];
    for (const f of view.files) {
      if (f.state === "missing") {
        missingSpokes.push(f.name);
      } else if (f.state === "mismatch" || f.state === "occupied" || f.state === "blocked") {
        conflicts.push({
          target: "view",
          path: view.viewName,
          file: f.name,
          reason: f.state,
          ...(f.actualTarget !== undefined ? { actualTarget: f.actualTarget } : {}),
        });
      }
      // "correct" → already wired.
    }
    if (missingSpokes.length > 0) {
      incompleteWiring.push({ target: "view", path: view.viewName, files: missingSpokes });
    }
  }
  // "no-view" contributes nothing.

  return {
    missingCanonicals,
    incompleteWiring,
    conflicts,
    collisions,
    unreachable: plan.unreachable,
    // `unreachable` is intentionally NOT part of `ok`: a declared repo that is not
    // cloned on this machine is an advisory fact (partial checkout), not drift the
    // operator must fix here. Only actionable drift denies `ok`.
    ok:
      missingCanonicals.length === 0 &&
      incompleteWiring.length === 0 &&
      conflicts.length === 0 &&
      collisions.length === 0,
  };
}
