/**
 * Agent instruction-file wiring (the read-only first step of the "saddle"
 * model's view/instruction/gitignore generation). For each declared repo, the
 * agent instruction files (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md)
 * should be present as GITIGNORED symlinks to a canonical source, never tracked
 * in a public repo's git history (where they would expose the private canonical
 * content they point at). This summarizes the on-disk + git facts the CLI
 * gathers and surfaces the privacy-relevant drift; it generates nothing.
 *
 * Pure: it judges already-gathered facts (presence + git-tracked status). The
 * filesystem / git probing that produces those facts is the caller's job.
 */

import type { RepoVisibility } from "./roster.js";

/** On-disk + git state of one instruction file in one repo. */
export type InstructionFileFact = {
  /** Repo-relative file name, e.g. "AGENTS.md", ".github/copilot-instructions.md". */
  name: string;
  /** Exists on disk (a regular file or a symlink, including a broken one). */
  present: boolean;
  /** Tracked by the repo's git (committed / staged). */
  tracked: boolean;
};

/** The gathered wiring facts for one declared repo. */
export type RepoWiringFacts = {
  /** Roster repo path (relative to the manifest root). */
  path: string;
  /** Declared visibility; undefined when the operator has not set it yet. */
  visibility?: RepoVisibility | undefined;
  /**
   * True when this repo declares `instructions: self`: its instruction files are
   * committed BY DESIGN (shared in its own git history), so a tracked file is
   * never a privacy risk — the repo is reported as `self` and excluded from the
   * risk / unknown verdicts. Absent => the default `hub` behavior, unchanged.
   */
  self?: boolean | undefined;
  /** False when the repo path could not be resolved / is not a usable git repo. */
  reachable: boolean;
  /** Per instruction-file facts (omitted/empty when unreachable). */
  instructionFiles: InstructionFileFact[];
};

/**
 * A privacy risk: a public-facing repo tracks an instruction file in git, which
 * can expose the private canonical content the file points at.
 */
export type WiringRisk = {
  repo: string;
  visibility: Extract<RepoVisibility, "public" | "future-public">;
  file: string;
};

export type WiringSummary = {
  /** Echo of the per-repo facts (for `--json` and the detailed view). */
  repos: RepoWiringFacts[];
  /** Public / future-public repos with a tracked instruction file. */
  risks: WiringRisk[];
  /** Repo paths whose visibility is unset, so the privacy verdict cannot be judged. */
  unknown: string[];
  /**
   * `instructions: self` repo paths: their instruction files are committed by
   * design, so they carry no privacy risk and do not need a visibility verdict.
   * Reported (not silently dropped) and do NOT block `ok`.
   */
  self: string[];
  /** Repos missing one or more instruction files (a wiring gap a later generate slice fills). */
  incomplete: { repo: string; missing: string[] }[];
  /** Repo paths that could not be resolved / are not usable git repos. */
  unreachable: string[];
  /** True when there are no risks, no unknown visibility, and no unreachable repos. */
  ok: boolean;
};

/** Whether a visibility exposes git history to the public (so tracked instruction files leak). */
function isPublicFacing(v: RepoVisibility | undefined): v is "public" | "future-public" {
  return v === "public" || v === "future-public";
}

/**
 * Summarize {@link RepoWiringFacts} into the privacy-relevant verdict. A
 * public-facing repo that TRACKS an instruction file is a {@link WiringRisk}
 * (its git history can expose the private canonical it points at); a repo with
 * unset visibility cannot be judged (`unknown`); a repo missing instruction
 * files is `incomplete` (a wiring gap, not a privacy problem). A `self` repo is
 * reported as `self` and bypasses the risk / unknown verdicts entirely — its
 * instruction files are committed by design — though a genuinely missing one is
 * still surfaced as `incomplete`. `ok` is true only when nothing is at risk,
 * every repo is judgeable, and every repo is reachable.
 */
export function summarizeWiring(facts: RepoWiringFacts[]): WiringSummary {
  const risks: WiringRisk[] = [];
  const unknown: string[] = [];
  const self: string[] = [];
  const incomplete: { repo: string; missing: string[] }[] = [];
  const unreachable: string[] = [];

  for (const f of facts) {
    if (!f.reachable) {
      unreachable.push(f.path);
      continue;
    }
    if (f.self === true) {
      // A `self` repo's tracked instruction files are intentional (committed,
      // shared), so they are never a privacy risk and need no visibility verdict.
      self.push(f.path);
    } else if (isPublicFacing(f.visibility)) {
      for (const file of f.instructionFiles) {
        if (file.tracked) risks.push({ repo: f.path, visibility: f.visibility, file: file.name });
      }
    } else if (f.visibility === undefined) {
      unknown.push(f.path);
    }
    const missing = f.instructionFiles.filter((file) => !file.present).map((file) => file.name);
    if (missing.length > 0) incomplete.push({ repo: f.path, missing });
  }

  return {
    repos: facts,
    risks,
    unknown,
    self,
    incomplete,
    unreachable,
    ok: risks.length === 0 && unknown.length === 0 && unreachable.length === 0,
  };
}
