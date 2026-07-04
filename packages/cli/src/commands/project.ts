import {
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type AdoptCandidate,
  type AnchorStarterRepo,
  type ArchivePlan,
  appendBasouGitignore,
  basouPaths,
  classifyRetrofit,
  createManifest,
  type ExistingViewLink,
  ensureBasouDirectory,
  GENERATED_END,
  GENERATED_START,
  type GitignorePlanSummary,
  type InstructionFileFact,
  type InstructionSymlinkFact,
  type InstructionSymlinkState,
  instructionMode,
  isGitNotFound,
  type Manifest,
  type PresetAction,
  type PresetMarkerKind,
  type PresetPlanSummary,
  parseMarkers,
  pathBasename,
  planArchive,
  planGitignore,
  planRename,
  planRosterAdoption,
  planWorkspaceView,
  type RenamePlan,
  type RepoEntry,
  type RepoGitignoreFacts,
  type RepoGitignorePlan,
  type RepoInstructions,
  type RepoPresetFacts,
  type RepoPresetPlan,
  type RepoSymlinkFacts,
  type RepoSymlinkPlan,
  type RepoWiringFacts,
  type RetrofitFacts,
  type RetrofitPlan,
  type RosterAdoptionPlan,
  type RosterDriftSummary,
  readManifest,
  readMarkdownFile,
  reconcileSourceRoots,
  removeMarkerSection,
  renderAnchorStarter,
  renderViewPresetBlock,
  renderWithMarkers,
  resolveRepositoryRoot,
  type SourceRootsReconcile,
  type SymlinkPlanSummary,
  safeSimpleGit,
  seedMarkers,
  summarizePresetPlan,
  summarizeRosterDrift,
  summarizeSymlinkPlan,
  summarizeWiring,
  unknownManifestKeys,
  type ViewPresetRepo,
  type ViewRepoFact,
  type WiringSummary,
  type WorkspaceViewPlan,
  writeManifest,
  writeMarkdownFile,
} from "@basou/core";
import type { Command } from "commander";
import { extractCauseLabel, isVerbose, renderCliError } from "../lib/error-render.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import type { ImportContext } from "./import.js";

export type ProjectCheckOptions = {
  json?: boolean;
  verbose?: boolean;
};

export type ProjectCheckContext = ImportContext;

export type ProjectSyncOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

/** `now` is injectable so the `updated_at` bump on `--apply` is deterministic in tests. */
export type ProjectSyncContext = ImportContext & { now?: () => Date };

/** Flat result of {@link doRunProjectSync}: the reconciliation plus what was done. */
export type ProjectSyncResult = SourceRootsReconcile & {
  /** Whether a repo roster (`repos`) was declared at all (else there is nothing to sync from). */
  hasRoster: boolean;
  /** Whether the manifest was written (i.e. `--apply` was set AND there was drift to reconcile). */
  applied: boolean;
  /** Unknown top-level manifest fields the loose schema preserved (surfaced, never dropped). */
  preservedUnknownFields: string[];
};

export type ProjectAdoptOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

/** `now` is injectable so the `updated_at` bump on `--apply` is deterministic in tests. */
export type ProjectAdoptContext = ImportContext & { now?: () => Date };

/** Flat result of {@link doRunProjectAdopt}: the proposed roster plus what was done. */
export type ProjectAdoptResult = RosterAdoptionPlan & {
  /** Whether a `repos` roster was ALREADY declared (adopt is a one-time bootstrap; `--apply` refuses). */
  alreadyDeclared: boolean;
  /** Whether the manifest was written (i.e. `--apply` set, no existing roster, AND at least one repo found). */
  applied: boolean;
  /** Unknown top-level manifest fields the loose schema preserved (surfaced, never dropped). */
  preservedUnknownFields: string[];
};

export type ProjectWiringOptions = {
  json?: boolean;
  verbose?: boolean;
};

export type ProjectWiringContext = ImportContext;

/** Result of {@link doRunProjectWiring}: the wiring summary plus whether a roster was declared. */
export type ProjectWiringResult = WiringSummary & {
  /** Whether a `repos` roster was declared (else there is nothing to inspect — run adopt first). */
  hasRoster: boolean;
};

export type ProjectGitignoreOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectGitignoreContext = ImportContext;

/** Result of {@link doRunProjectGitignore}: the plan plus whether a roster exists and whether it was applied. */
export type ProjectGitignoreResult = GitignorePlanSummary & {
  /** Whether a `repos` roster was declared (else there is nothing to generate — run adopt first). */
  hasRoster: boolean;
  /** Whether `.gitignore` files were written (i.e. `--apply` was set AND there was something to add). */
  applied: boolean;
};

export type ProjectSymlinksOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectSymlinksContext = ImportContext;

/**
 * The workspace view's own instruction-file spokes (AGENTS.md → the anchor
 * canonical, CLAUDE.md → AGENTS.md, Copilot → ../AGENTS.md) — the same hub-shape
 * wiring as a repo's, generated INTO the view directory. Reported separately: the
 * view is not a roster repo.
 */
export type ViewSymlinksOutcome =
  /** No `workspace.view` declared. */
  | { kind: "no-view" }
  /**
   * The view's basename equals a roster repo's resolved canonical name — both
   * would own the SAME `agents/<name>/AGENTS.md`, so no view spoke is wired and
   * the ambiguity is surfaced for the operator to rename one side.
   */
  | { kind: "collision"; viewName: string; repoPath: string }
  /** The view's own canonical (`agents/<viewName>/AGENTS.md`) does not exist yet, so nothing is wired (preset runs first). */
  | { kind: "missing-canonical"; viewName: string }
  /** The view's instruction links are inspected; `files` carries each spoke's state and target. */
  | { kind: "gathered"; viewName: string; files: InstructionSymlinkFact[] };

/** Result of {@link doRunProjectSymlinks}: the plan plus whether a roster exists and what `--apply` did. */
export type ProjectSymlinksResult = SymlinkPlanSummary & {
  /** Whether a `repos` roster was declared (else there is nothing to generate — run adopt first). */
  hasRoster: boolean;
  /** Whether any symlinks were actually created (true only when `--apply` created at least one link). */
  applied: boolean;
  /** Per-file failures encountered during `--apply` (collected, not thrown — kept transparent). */
  failures: { repo: string; file: string; message: string }[];
  /**
   * The workspace view's own instruction-symlink outcome (a separately reported
   * target). Absent when the roster is empty: the whole run is then a no-op, so
   * the view is neither inspected nor written.
   */
  view?: ViewSymlinksOutcome;
  /** Spokes actually created in the view directory by `--apply`. */
  viewCreated: string[];
  /** Per-file view-link create failures from `--apply` (collected, not thrown — pathless reason). */
  viewFailures: { file: string; message: string }[];
};

export type ProjectRetrofitOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectRetrofitContext = ImportContext;

/**
 * The workspace view's own canonical auto-migration outcome. A view whose
 * canonical (`agents/<viewName>/AGENTS.md`) is markerless hand-written prose is
 * migrated by PREPENDING the generated block via `seedMarkers` (the prose is kept
 * verbatim). This is retrofit's escape hatch for the class `project preset`
 * refuses (it surfaces a markerless canonical as a conflict rather than clobber).
 */
export type ViewRetrofitOutcome =
  /** No `workspace.view` declared — nothing to migrate. */
  | { kind: "no-view" }
  /**
   * The view's basename equals a roster repo's resolved canonical name — the
   * canonical is shared, so nothing is migrated (writing the view block into it
   * would corrupt the repo's relocated prose, and vice versa).
   */
  | { kind: "collision"; viewName: string; repoPath: string }
  /** The view canonical is absent — retrofit does not create it (`preset` / `derive` do); no migration. */
  | { kind: "absent"; viewName: string }
  /** The view canonical already has a BASOU:GENERATED region (well-formed) — nothing to migrate. */
  | { kind: "already-marked"; viewName: string }
  /** The view canonical is markerless prose — the generated block will be / was prepended. */
  | { kind: "seed"; viewName: string; block: string }
  /** The view canonical exists but could not be read (a directory, permissions, …). */
  | { kind: "unreadable"; viewName: string }
  /** The view canonical has malformed markers — surfaced, never rewritten. */
  | { kind: "malformed"; viewName: string; reason: Exclude<PresetMarkerKind, "ok" | "no_markers"> };

/** The view-migration fields shared by both {@link ProjectRetrofitResult} forms. */
type ViewMigrationFields = {
  /** Whether a `repos` roster was declared at all. */
  hasRoster: boolean;
  /**
   * The workspace view's own canonical auto-migration outcome (a separate,
   * `seedMarkers`-based step). Absent when the roster is empty: the whole run is
   * then a no-op, so the view is neither inspected nor written.
   */
  view?: ViewRetrofitOutcome;
  /**
   * True when `--apply` prepended the generated block into the view canonical.
   * Only the bare (view-only) form ever writes the view, so this is always
   * `false` on a repo-argument result (which reports the pending seed instead).
   */
  viewApplied: boolean;
  /** A pathless failure label when the view canonical's `--apply` seed write failed. */
  viewFailure?: string;
};

/** Result of a bare run (`retrofit` without a repo argument): only the view canonical's migration. */
export type ProjectRetrofitViewOnlyResult = ViewMigrationFields & {
  /** Discriminant: the bare, view-only form. */
  kind: "view-only";
};

/** Result of a repo-argument run: the classified plan plus what `--apply` did (pre-existing fields unchanged; `kind` is additive). */
export type ProjectRetrofitRepoResult = RetrofitPlan &
  ViewMigrationFields & {
    /** Discriminant: the repo-argument form. */
    kind: "repo";
    /** True only when `--apply` actually relocated the file and recreated the symlink. */
    applied: boolean;
    /** A pathless failure label when an `--apply` move/symlink step failed (collected, not thrown). */
    failure?: string;
    /** True when the failure left on-disk state changed (the canonical was written before a later step failed). */
    partial?: boolean;
  };

/**
 * Result of {@link doRunProjectRetrofit}: the repo-argument form, or the
 * view-only form when no repo argument was given — discriminate with
 * `result.kind`.
 */
export type ProjectRetrofitResult = ProjectRetrofitRepoResult | ProjectRetrofitViewOnlyResult;

export type ProjectWorkspaceOptions = {
  apply?: boolean;
  prune?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectWorkspaceContext = ImportContext;

/** Result of {@link doRunProjectWorkspace}: the view plan plus whether a view is declared and what `--apply` / `--prune` did. */
export type ProjectWorkspaceResult = WorkspaceViewPlan & {
  /** Whether `workspace.view` is declared (else there is no view to generate — solo project / not configured). */
  hasView: boolean;
  /** Whether any view symlinks were actually created (true only when `--apply` created at least one). */
  applied: boolean;
  /** Whether any stray view symlinks were actually removed (true only when `--prune` removed at least one). */
  pruned: boolean;
  /**
   * Whether `--prune` was requested with strays to remove but withheld because one
   * or more declared repos are unreachable (an unreachable repo's link can be
   * indistinguishable from a stray, so pruning is refused until the roster resolves).
   */
  pruneWithheld: boolean;
  /** Per-link create failures encountered during `--apply` (collected, not thrown — pathless reason). */
  failures: { name: string; message: string }[];
  /** Per-link prune failures encountered during `--prune` (collected, not thrown — pathless reason). */
  pruneFailures: { name: string; message: string }[];
};

export type ProjectPresetOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectPresetContext = ImportContext;

/**
 * The workspace view's own canonical is a SECOND preset target, generated by the
 * same BASOU:GENERATED mechanism as each repo's. Its canonical lives at the anchor
 * (`agents/<viewName>/AGENTS.md`, viewName = the view directory's basename), so it
 * is judged and generated alongside the roster but reported separately (the view is
 * not a repo — it has no `.git` and never enters the roster collision detection).
 */
export type ViewPresetOutcome =
  /** No `workspace.view` declared — nothing to generate for the view. */
  | { kind: "no-view" }
  /**
   * The view's basename equals a roster repo's resolved canonical name — both
   * would own the SAME `agents/<name>/AGENTS.md`, so neither side is generated
   * (the repo side is suppressed via the summary's collisions).
   */
  | { kind: "collision"; viewName: string; repoPath: string }
  /** The view canonical is absent (a create) or its BASOU:GENERATED region is out of date (an update). */
  | { kind: "plan"; action: PresetAction; canonicalName: string; viewName: string; block: string }
  /** The view canonical's generated region already matches (nothing to write). */
  | { kind: "in-sync"; canonicalName: string; viewName: string }
  /** The view canonical exists but its markers are absent/malformed — surfaced, never clobbered. */
  | {
      kind: "conflict";
      canonicalName: string;
      viewName: string;
      reason: Exclude<PresetMarkerKind, "ok">;
    }
  /** The view canonical exists but could not be read (a directory, permissions, …) — degraded. */
  | { kind: "unreadable"; canonicalName: string; viewName: string };

/** Result of {@link doRunProjectPreset}: the plan plus whether a roster exists and what `--apply` did. */
export type ProjectPresetResult = PresetPlanSummary & {
  /** Whether a `repos` roster was declared (else there is nothing to generate — run adopt first). */
  hasRoster: boolean;
  /** Whether any canonical was actually written (true only when `--apply` wrote at least one). */
  applied: boolean;
  /** Per-repo write failures encountered during `--apply` (collected, not thrown — pathless reason). */
  failures: { repo: string; message: string }[];
  /**
   * The workspace view's own canonical outcome (a second, separately reported
   * preset target). Absent when the roster is empty: the whole run is then a
   * no-op, so the view is neither inspected nor written.
   */
  view?: ViewPresetOutcome;
  /** True when `--apply` wrote the view canonical. */
  viewApplied: boolean;
  /** A pathless failure label when the view canonical's `--apply` write failed (collected, not thrown). */
  viewFailure?: string;
};

export type ProjectArchiveOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

/** `now` is injectable so the `updated_at` bump on `--apply` is deterministic in tests. */
export type ProjectArchiveContext = ImportContext & { now?: () => Date };

/** Repo-side wiring still present for the archived repo — a manual-teardown checklist (report-only). */
export type ArchiveTeardown = {
  /** False when the repo could not be resolved on disk (e.g. already deleted) — wiring not inspected. */
  inspected: boolean;
  /** The workspace view still has a `<basename>` entry for this repo. */
  viewLink: boolean;
  /** Instruction files still present in the repo (AGENTS.md / CLAUDE.md / copilot). */
  instructionFiles: string[];
  /** Instruction patterns still listed in the repo's `.gitignore`. */
  gitignorePatterns: string[];
  /** The anchor's canonical (`agents/<repo>/AGENTS.md`) still exists. */
  canonical: boolean;
};

/**
 * Why one teardown candidate is or is not safe to auto-remove.
 * - `removable`: verified basou-generated and provably owned — a symlink whose
 *   target matches what the generator would write, or a well-formed
 *   `BASOU:GENERATED` block. `--apply` removes these (re-verifying first).
 * - `manual`: present and plausibly basou's, but NOT provably owned — a bare
 *   `.gitignore` pattern line, which the generator appends WITHOUT a marker, so
 *   it is indistinguishable from a hand-added identical line. Reported as a
 *   manual-cleanup checklist; `--apply` NEVER removes it.
 * - `foreign`: present but NOT ours (a real file, a symlink pointing elsewhere, a
 *   canonical with no generated block) — never touched.
 * - `blocked`: could not be inspected, or is ambiguous (e.g. a basename collision
 *   with another repo sharing the canonical/view name) — never touched.
 */
export type TeardownItemState = "removable" | "manual" | "foreign" | "blocked";

export type TeardownItem = {
  /** Stable artifact kind for JSON consumers. */
  kind: "instruction-symlink" | "gitignore" | "view-symlink" | "canonical-block";
  /** Repo-relative file / pattern / canonical path being considered. */
  label: string;
  state: TeardownItemState;
  /** Why it is manual/foreign/blocked, or a caveat for a removable item (e.g. the canonical empties out). */
  note?: string;
};

/** Read-only classification of a single repo's basou-generated wiring for teardown. */
export type RepoTeardownPlan = {
  /** The target path as given on the command line. */
  target: string;
  /** False when the path could not be resolved on disk (its in-repo wiring is then uninspectable). */
  resolved: boolean;
  /** The target's realpath at scan time, or null when unresolvable — `--apply` binds to this so a path swap between scan and apply cannot redirect a destructive write. */
  repoReal: string | null;
  /** The basename `--apply` uses for the canonical / view artifacts, bound from scan time (never recomputed under a swapped target). */
  canonicalName: string;
  /** True when the target resolves to the anchor itself — refused, never torn down. */
  isAnchor: boolean;
  /** Whether the target is still a declared roster member (informational; teardown is path-driven, not roster-driven). */
  inRoster: boolean;
  /** Present artifacts, classified. Absent artifacts (nothing to remove) are omitted. */
  items: TeardownItem[];
  /** Count of items in state `removable` (excludes `manual`). */
  removableCount: number;
};

export type ProjectTeardownOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ProjectTeardownContext = {
  cwd?: string;
};

/** Result of {@link doRunProjectTeardown}: the plan plus what `--apply` removed. */
export type ProjectTeardownResult = RepoTeardownPlan & {
  /** Whether `--apply` ran (target resolvable, not the anchor, and at least one removable item). */
  applied: boolean;
  /** Labels actually removed by `--apply`. */
  removed: string[];
  /** Per-artifact failures from `--apply` (collected, never thrown). */
  failed: { label: string; message: string }[];
};

/** Result of {@link doRunProjectArchive}: the plan plus whether a roster exists, the teardown checklist, and what `--apply` did. */
export type ProjectArchiveResult = ArchivePlan & {
  /** Whether a `repos` roster was declared (else there is nothing to archive — run adopt first). */
  hasRoster: boolean;
  /** Whether the manifest was written (i.e. `--apply` set, target found, and not the anchor). */
  applied: boolean;
  /** Repo-side wiring still present (report-only; `--apply` never touches it). */
  teardown: ArchiveTeardown;
  /** Unknown top-level manifest fields the loose schema preserved (surfaced, never dropped). */
  preservedUnknownFields: string[];
};

export type ProjectRenameOptions = {
  apply?: boolean;
  json?: boolean;
  verbose?: boolean;
};

/** `now` is injectable so the `updated_at` bump on `--apply` is deterministic in tests. */
export type ProjectRenameContext = ImportContext & { now?: () => Date };

/** Repo-side wiring at the OLD basename that a basename-changing rename leaves stale — a manual checklist (report-only). */
export type RenameWiring = {
  /** The anchor canonical dir `agents/<oldBasename>` still exists (rename to the new basename). */
  canonicalDirOld: boolean;
  /** The workspace view still has a `<oldBasename>` entry (rename to the new basename). */
  viewLinkOld: boolean;
};

/** Result of {@link doRunProjectRename}: the plan plus whether a roster exists, the repo-side checklist, and what `--apply` did. */
export type ProjectRenameResult = RenamePlan & {
  /** Whether a `repos` roster was declared (else there is nothing to rename — run adopt first). */
  hasRoster: boolean;
  /** Whether the manifest was written (i.e. `--apply` set and the rename was actionable). */
  applied: boolean;
  /** Repo-side wiring still at the old basename (report-only; `--apply` never touches it). */
  wiring: RenameWiring;
  /** Unknown top-level manifest fields the loose schema preserved (surfaced, never dropped). */
  preservedUnknownFields: string[];
};

export type ProjectNewOptions = {
  apply?: boolean;
  /**
   * The workspace view. Commander folds `--view <path>` and `--no-view` onto the
   * same `view` property: a string is the override path, `false` is `--no-view`
   * (solo project), and `undefined` is the default (`<name>-workspace` sibling).
   */
  view?: string | false;
  /** Write a `.basou/` full-exclude .gitignore block instead of the default ignore+commit block. */
  localOnly?: boolean;
  force?: boolean;
  json?: boolean;
  verbose?: boolean;
};

/** `now` is injectable so the `updated_at` bump on `--apply` is deterministic in tests. */
export type ProjectNewContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
};

/** Flat result of {@link doRunProjectNew}: the scaffolded declaration plus what was done. */
export type ProjectNewResult = {
  /** The workspace name, derived from the anchor repo's directory name. */
  workspaceName: string;
  /** The seeded `repos` roster (anchor `.` first, then the deduped declared repos). */
  repos: RepoEntry[];
  /** The seeded `workspace.view` path, or null when `--no-view` (solo project). */
  view: string | null;
  /** The derived `import.source_roots` (the roster paths plus the view when present). */
  sourceRoots: string[];
  /** Declared repo paths that are not git repositories (rejected — basou never creates repos). */
  invalidRepos: string[];
  /** Whether a `.basou/manifest.yaml` already existed at the anchor (then `--force` is required). */
  existed: boolean;
  /** Whether the manifest was written (i.e. `--apply` was set). */
  applied: boolean;
};

export type ProjectDeriveOptions = {
  apply?: boolean;
  verbose?: boolean;
};

/** `now` is injectable so each delegated step's `updated_at` bump is deterministic in tests. */
export type ProjectDeriveContext = ImportContext & { now?: () => Date };

/**
 * Agent instruction files inspected per repo. GEMINI.md is intentionally absent
 * (the Gemini CLI was discontinued for personal use). Each should be a gitignored
 * symlink to a canonical source, never tracked in a public repo's history.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"] as const;

/**
 * The canonical instruction file name. It lives in the anchor at
 * `agents/<repo>/AGENTS.md` and is the hub each repo's own AGENTS.md symlink
 * resolves to; CLAUDE.md and Copilot are spokes pointing back at it.
 */
const CANONICAL_FILE = "AGENTS.md";

/**
 * Wire `basou project` (a read-only inspector for the project's declared repo
 * roster) and its `check` subcommand onto `program`. The roster is the single
 * source of truth for which repos make up a project; `check` compares it
 * against the capture config (`source_roots`) and surfaces drift. It writes
 * nothing and enforces nothing.
 */
export function registerProjectCommand(program: Command): void {
  const project = program
    .command("project")
    .description("Inspect a project's declared repo roster (read-only)");

  project
    .command("check")
    .description(
      "Compare the declared repo roster (manifest `repos`) against the capture config (`source_roots`) and surface drift (read-only, advisory)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectCheckOptions) => {
      await runProjectCheck(opts);
    });

  project
    .command("sync")
    .description(
      "Reconcile the capture config (`source_roots`) to cover every declared repo (manifest `repos`). Dry-run by default; pass --apply to write. Additive only — it never removes an existing source root (e.g. the workspace view)",
    )
    .option(
      "--apply",
      "Write the reconciled source_roots to the manifest (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectSyncOptions) => {
      await runProjectSync(opts);
    });

  project
    .command("adopt")
    .description(
      "Bootstrap a repo roster (manifest `repos`) from the existing capture config (`source_roots`): classify each by realpath + `.git`, keep the git repos, exclude non-repos (the workspace view, /tmp). Dry-run by default; pass --apply to write (refuses if a roster already exists)",
    )
    .option("--apply", "Write the bootstrapped roster to the manifest (default: dry-run preview)")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectAdoptOptions) => {
      await runProjectAdopt(opts);
    });

  project
    .command("wiring")
    .description(
      "Inspect each declared repo's agent instruction-file wiring (AGENTS.md, CLAUDE.md, copilot-instructions.md): present? tracked by git? Surfaces privacy risks (a public repo tracking an instruction file) and gaps (read-only, advisory)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectWiringOptions) => {
      await runProjectWiring(opts);
    });

  project
    .command("gitignore")
    .description(
      "Reconcile each public-facing repo's .gitignore to exclude the agent instruction files (so the gitignored symlinks never enter public history). Dry-run by default; pass --apply to write. Additive only — it never removes a line; private repos and unset-visibility repos are left untouched",
    )
    .option(
      "--apply",
      "Append the missing patterns to each repo's .gitignore (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectGitignoreOptions) => {
      await runProjectGitignore(opts);
    });

  project
    .command("symlinks")
    .description(
      "Generate each declared repo's agent instruction-file symlinks (AGENTS.md, CLAUDE.md, copilot-instructions.md) pointing at the project anchor's canonical (agents/<repo>/AGENTS.md). Dry-run by default; pass --apply to create. Non-destructive — it only creates missing links and never overwrites an existing file or repoints a link",
    )
    .option("--apply", "Create the missing instruction-file symlinks (default: dry-run preview)")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectSymlinksOptions) => {
      await runProjectSymlinks(opts);
    });

  project
    .command("workspace")
    .description(
      "Generate the project's workspace view: a directory (manifest `workspace.view`) that aggregates every declared repo via a `<repo-basename>` symlink (the anchor included). Dry-run by default; pass --apply to create missing links. Creation is non-destructive — it never overwrites an existing entry or repoints a link. Stray repo links (a view symlink whose repo is no longer in the roster) are reported always and removed only with --prune; pruning removes ONLY a symlink whose relative target resolves to a git repository (never a real file/dir, the view's own instruction files, a broken link, or a non-repo target), and never the linked repo itself",
    )
    .option("--apply", "Create the missing view symlinks (default: dry-run preview)")
    .option(
      "--prune",
      "Remove stray repo symlinks (links the roster no longer backs); default: dry-run preview. Independent of --apply",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectWorkspaceOptions) => {
      await runProjectWorkspace(opts);
    });

  project
    .command("preset")
    .description(
      "Generate the stable-preset block (source visibility, source language, published surfaces) of each declared repo's canonical instruction file (agents/<repo>/AGENTS.md) from the manifest. Dry-run by default; pass --apply to write. Non-destructive — it only writes the marker-delimited region (creating an absent canonical, updating an out-of-date one) and never touches hand-authored content or a canonical whose markers are missing/malformed",
    )
    .option(
      "--apply",
      "Write the generated preset block to each canonical (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectPresetOptions) => {
      await runProjectPreset(opts);
    });

  project
    .command("archive")
    .argument("<repo>", "The roster repo path to archive (as declared, e.g. ../takuhon)")
    .description(
      "Fold a repo out of the project: remove it from the declared roster (manifest `repos`) and prune its capture entry (`source_roots`). Dry-run by default; pass --apply to write. Manifest-only and reversible (the manifest is git-tracked); it never deletes the repo, its captured history, or its on-disk wiring (view symlink / instruction symlinks / .gitignore / canonical) — those are reported as a manual teardown checklist. Archiving the anchor (`.`) is refused",
    )
    .option(
      "--apply",
      "Write the pruned roster / source_roots to the manifest (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (repo: string, opts: ProjectArchiveOptions) => {
      await runProjectArchive(repo, opts);
    });

  project
    .command("rename")
    .argument("<old>", "The current roster repo path (as declared, e.g. ../takuhon)")
    .argument("<new>", "The new roster repo path (e.g. ../takuhon-cli)")
    .description(
      "Re-path a repo in the project: update its declared roster path (manifest `repos`) and its capture entry (`source_roots`). Dry-run by default; pass --apply to write. Manifest-only and reversible (the manifest is git-tracked); it does not move the repo on disk or rewire it — when the basename changes, the anchor canonical dir and view symlink that still use the old name are reported as a manual checklist (re-run `basou project symlinks` / `workspace` after). Renaming the anchor (`.`) or onto an existing entry is refused",
    )
    .option(
      "--apply",
      "Write the re-pathed roster / source_roots to the manifest (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (oldPath: string, newPath: string, opts: ProjectRenameOptions) => {
      await runProjectRename(oldPath, newPath, opts);
    });

  project
    .command("teardown")
    .argument("<repo>", "The repo path whose basou-generated wiring to tear down (e.g. ../takuhon)")
    .description(
      "Remove the basou-generated wiring for one repo: its instruction symlinks (AGENTS.md / CLAUDE.md / copilot), its `.gitignore` patterns, its workspace view symlink, and the generated block in the anchor's canonical. Dry-run by default (a classified plan: removable / foreign / blocked); pass --apply to remove ONLY the verified-basou artifacts, re-checking each just before it acts — a real file, a foreign symlink, or hand-authored canonical prose is never touched. This is the destructive counterpart to `archive` (which only drops the manifest declaration): archive first, then teardown to clean the on-disk wiring. The anchor (`.`) is refused. Not reversible — the manifest is git-tracked but the removed symlinks/lines are not",
    )
    .option("--apply", "Remove the verified-basou artifacts (default: dry-run classified preview)")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (repo: string, opts: ProjectTeardownOptions) => {
      await runProjectTeardown(repo, opts);
    });

  project
    .command("new")
    .argument("[repos...]", "Extra repo paths (besides the anchor) to seed into the roster")
    .description(
      "Scaffold a new project from scratch at the current Git repository (the anchor): create `.basou/` and seed the manifest with a candidate `repos` roster (the anchor plus any given repos, which must already be git repositories) and a `workspace.view` placeholder. Dry-run by default; pass --apply to write. Pass --no-view for a solo project. The greenfield entry point — declare visibility/language per repo afterward, then run `basou project derive --apply` to materialize the wiring",
    )
    .option("--apply", "Create `.basou/` and write the seeded manifest (default: dry-run preview)")
    .option(
      "--view <path>",
      "Override the workspace view path (default: a <name>-workspace sibling)",
    )
    .option("--no-view", "Solo project: declare no workspace view")
    .option(
      "--local-only",
      "Write a .basou/ full-exclude .gitignore block (keep the trail out of version control) instead of the default ignore+commit block",
    )
    .option("-f, --force", "Overwrite an existing manifest")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (repos: string[], opts: ProjectNewOptions) => {
      await runProjectNew(repos, opts);
    });

  project
    .command("derive")
    .description(
      "Materialize a project's full wiring from the declared manifest: sync `source_roots` to the roster, generate each repo's canonical preset block, its instruction-file symlinks, the workspace view, and each public repo's .gitignore — in dependency order. Dry-run by default; pass --apply to write. The greenfield counterpart to `new` (run after declaring visibility/language) and a one-shot maintenance pass. Re-runnable: each step is idempotent, so a partial apply recovers on a second run",
    )
    .option("--apply", "Run every step in apply mode (default: dry-run preview)")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: ProjectDeriveOptions) => {
      await runProjectDerive(opts);
    });

  project
    .command("retrofit")
    .argument(
      "[repo]",
      "The declared roster repo whose hand-authored AGENTS.md to relocate (e.g. ../foo). Omit to run only the workspace view's canonical auto-migration",
    )
    .description(
      "Fold an existing repo's hand-authored AGENTS.md into the project topology: move the repo's regular-file `AGENTS.md` to the anchor canonical (`agents/<repo>/AGENTS.md`) and replace it with a symlink, so the prose lives at the single source of truth. Dry-run by default; pass --apply to relocate. The onboarding counterpart to `new` for a repo that already carries its own AGENTS.md — run it before `basou project derive`, which then adds the preset block, the CLAUDE.md / Copilot spokes, and the .gitignore. Non-destructive: it refuses when the destination canonical already exists (it never clobbers it), and skips a repo whose AGENTS.md is already a symlink or absent. The anchor (`.`) is refused. The workspace view's own canonical is auto-migrated when it is markerless prose (the generated block is prepended, the prose kept): omit the repo argument to perform that migration — a repo-argument run only reports it",
    )
    .option(
      "--apply",
      "Relocate the AGENTS.md to the canonical and recreate the symlink (default: dry-run preview)",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (repo: string | undefined, opts: ProjectRetrofitOptions) => {
      await runProjectRetrofit(repo, opts);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectCheck}. */
export async function runProjectCheck(
  options: ProjectCheckOptions,
  ctx: ProjectCheckContext = {},
): Promise<void> {
  try {
    await doRunProjectCheck(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * The capture roots a manifest effectively scans. An absent `import.source_roots`
 * means "the host repository only" (import's documented default), so it resolves
 * to `["."]` here — NOT the empty set. Comparing the roster against the empty set
 * would falsely report the host `.` as a capture gap after a solo-repo adoption.
 */
function effectiveSourceRoots(manifest: Manifest): string[] {
  return manifest.import?.source_roots ?? ["."];
}

/**
 * Header advisory lines naming the unknown top-level manifest fields the loose
 * schema preserved (empty array => no lines). Surfaced by the read-modify-write
 * commands so preservation is not silent: basou keeps a field it does not
 * recognize (a newer version's section, a future adapter, a hand-added/typo'd
 * key) rather than dropping it on write, and says so.
 */
function preservedUnknownLines(fields: string[]): string[] {
  if (fields.length === 0) return [];
  return [
    `ℹ️ Preserving ${fields.length} unrecognized top-level manifest field${fields.length === 1 ? "" : "s"} (kept on write, never dropped): ${fields.join(", ")}`,
    "",
  ];
}

/** Pure runner: resolves the workspace, reads the manifest, computes the drift, prints it (or JSON). */
export async function doRunProjectCheck(
  options: ProjectCheckOptions,
  ctx: ProjectCheckContext,
): Promise<RosterDriftSummary> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project check");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const summary = summarizeRosterDrift({
    ...(manifest.repos !== undefined ? { repos: manifest.repos } : {}),
    sourceRoots: effectiveSourceRoots(manifest),
  });

  if (options.json === true) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(renderProjectCheck(summary));
  }
  return summary;
}

/**
 * Render the advisory report. Leads with the capture gaps (declared repos not
 * being captured — the actionable drift), then the captured-but-undeclared
 * paths (commonly the workspace view), and states the read-only / no-enforce
 * framing so the verdict is not over-read.
 */
export function renderProjectCheck(summary: RosterDriftSummary): string {
  const lines: string[] = [];
  lines.push("# Project composition check (declared vs captured)");
  lines.push("");

  if (summary.declaredCount === 0) {
    lines.push(
      "ℹ️ No repo roster declared (manifest `repos`). Running on `source_roots` alone, so there is nothing to compare the declaration against.",
    );
    if (summary.extra.length > 0) {
      lines.push("");
      lines.push(`Captured source_roots (${summary.extra.length}):`);
      for (const p of summary.extra) lines.push(`- ${p}`);
    }
    return lines.join("\n");
  }

  if (summary.gaps.length === 0) {
    lines.push(
      `✅ All ${summary.declaredCount} declared repo${summary.declaredCount === 1 ? " is" : "s are"} covered by the capture config (source_roots).`,
    );
  } else {
    lines.push(
      `⚠️ Declared but not captured: ${summary.gaps.length} repo${summary.gaps.length === 1 ? "" : "s"}`,
    );
    for (const g of summary.gaps) {
      lines.push(`- ${g.path}${g.visibility ? ` [${g.visibility}]` : ""} — not in source_roots`);
    }
  }
  lines.push("");

  if (summary.extra.length > 0) {
    lines.push(
      `## Captured but undeclared (${summary.extra.length}) — the workspace view, or a missing declaration`,
    );
    for (const p of summary.extra) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "Note: read-only advisory. It only shows the difference between the declaration (repos) and the capture config (source_roots); it does not enforce.",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectSync}. */
export async function runProjectSync(
  options: ProjectSyncOptions,
  ctx: ProjectSyncContext = {},
): Promise<void> {
  try {
    await doRunProjectSync(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Reconcile `source_roots` against the declared roster. Resolves the workspace,
 * reads the manifest, computes the additive reconciliation, and — only when
 * `--apply` is set and there is drift to fix — writes the manifest back (the
 * declared repos appended to `source_roots`, `workspace.updated_at` bumped).
 * Without `--apply` it writes nothing and prints the plan.
 */
export async function doRunProjectSync(
  options: ProjectSyncOptions,
  ctx: ProjectSyncContext,
): Promise<ProjectSyncResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project sync");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const hasRoster = manifest.repos !== undefined && manifest.repos.length > 0;
  const reconcile = reconcileSourceRoots({
    ...(manifest.repos !== undefined ? { repos: manifest.repos } : {}),
    ...(manifest.import?.source_roots !== undefined
      ? { sourceRoots: manifest.import.source_roots }
      : {}),
  });

  const applied = options.apply === true && hasRoster && !reconcile.unchanged;
  if (applied) {
    const now = ctx.now ?? (() => new Date());
    await writeManifest(
      paths,
      {
        ...manifest,
        import: { ...manifest.import, source_roots: reconcile.next },
        workspace: { ...manifest.workspace, updated_at: now().toISOString() },
      },
      { force: true },
    );
  }

  const result: ProjectSyncResult = {
    ...reconcile,
    hasRoster,
    applied,
    preservedUnknownFields: unknownManifestKeys(manifest),
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectSync(result));
  }
  return result;
}

/**
 * Render the sync report. Leads with the actionable outcome: nothing to sync
 * (no roster), already in sync, or the source roots that will be / were added.
 * The dry-run framing makes clear that without `--apply` nothing is written.
 */
export function renderProjectSync(result: ProjectSyncResult): string {
  const lines: string[] = [];
  lines.push("# source_roots sync (declared roster → capture config)");
  lines.push("");
  lines.push(...preservedUnknownLines(result.preservedUnknownFields));

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ No repo roster declared (manifest `repos`). There is no declaration to sync from, so nothing changes.",
    );
    return lines.join("\n");
  }

  if (result.unchanged) {
    lines.push("✅ source_roots already covers the entire declared roster (nothing to sync).");
    return lines.join("\n");
  }

  if (result.applied) {
    lines.push(
      `✅ Added ${result.added.length} entr${result.added.length === 1 ? "y" : "ies"} to source_roots:`,
    );
    for (const p of result.added) lines.push(`- ${p}`);
  } else {
    lines.push(
      `${result.added.length} repo${result.added.length === 1 ? " is" : "s are"} not in source_roots. To add (dry-run; pass --apply to write):`,
    );
    for (const p of result.added) lines.push(`- ${p}`);
    lines.push("");
    lines.push(
      "Note: existing source_roots are kept; only the missing entries are appended (nothing is removed).",
    );
  }
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectAdopt}. */
export async function runProjectAdopt(
  options: ProjectAdoptOptions,
  ctx: ProjectAdoptContext = {},
): Promise<void> {
  try {
    await doRunProjectAdopt(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Classify a declared source-root path against disk: a git repo root (`repo`),
 * a resolved-but-non-repo directory such as the workspace view or `/tmp`
 * (`non-repo`), or a path that does not resolve (`unresolved`). Resolves the
 * path relative to the repository root, then realpath (which follows the view's
 * symlink and unifies platform aliases) before probing for `.git`.
 */
function classifySourceRoot(repositoryRoot: string, declaredPath: string): AdoptCandidate {
  const absolute = resolve(repositoryRoot, declaredPath);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return { path: declaredPath, kind: "unresolved" };
  }
  return { path: declaredPath, kind: existsSync(join(real, ".git")) ? "repo" : "non-repo" };
}

/**
 * Bootstrap a `repos` roster from the existing `source_roots`. Resolves the
 * workspace, reads the manifest, classifies each source root on disk, and plans
 * the roster (git repos kept, non-repos/unresolved excluded). When `--apply` is
 * set, no roster exists yet, and at least one repo was found, it writes the
 * roster (and bumps `workspace.updated_at`). Without `--apply` — or when a
 * roster already exists — it writes nothing and prints the plan.
 *
 * `source_roots` absent mirrors import's default (the host repo `.` only), so a
 * solo repo adopts a `["."]` roster.
 */
export async function doRunProjectAdopt(
  options: ProjectAdoptOptions,
  ctx: ProjectAdoptContext,
): Promise<ProjectAdoptResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project adopt");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const alreadyDeclared = manifest.repos !== undefined && manifest.repos.length > 0;
  const candidates = effectiveSourceRoots(manifest).map((r) =>
    classifySourceRoot(repositoryRoot, r),
  );
  const plan = planRosterAdoption(candidates);

  const applied = options.apply === true && !alreadyDeclared && plan.repos.length > 0;
  if (applied) {
    const now = ctx.now ?? (() => new Date());
    await writeManifest(
      paths,
      {
        ...manifest,
        repos: plan.repos,
        workspace: { ...manifest.workspace, updated_at: now().toISOString() },
      },
      { force: true },
    );
  }

  const result: ProjectAdoptResult = {
    ...plan,
    alreadyDeclared,
    applied,
    preservedUnknownFields: unknownManifestKeys(manifest),
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectAdopt(result));
  }
  return result;
}

/**
 * Render the adoption report. Leads with the actionable outcome: a roster
 * already exists (nothing to bootstrap), nothing found, or the proposed roster
 * (with the excluded paths and why). The dry-run framing makes clear that
 * without `--apply` nothing is written, and reminds the operator to set
 * visibility afterward.
 */
export function renderProjectAdopt(result: ProjectAdoptResult): string {
  const lines: string[] = [];
  lines.push("# Bootstrap repo roster (source_roots → repos)");
  lines.push("");
  lines.push(...preservedUnknownLines(result.preservedUnknownFields));

  if (result.alreadyDeclared) {
    lines.push(
      "ℹ️ A repo roster (manifest `repos`) is already declared. adopt is a one-time bootstrap, so it writes nothing. Use `project check` / `project sync` for ongoing maintenance.",
    );
    return lines.join("\n");
  }

  if (result.repos.length === 0) {
    lines.push("ℹ️ No git repo found in source_roots (nothing to bootstrap).");
  } else if (result.applied) {
    lines.push(
      `✅ Wrote ${result.repos.length} repo${result.repos.length === 1 ? "" : "s"} to the repos roster:`,
    );
    for (const r of result.repos) lines.push(`- ${r.path}`);
    lines.push("");
    lines.push(
      "Note: visibility is unset. Assign public / private / future-public to each repo manually.",
    );
  } else {
    lines.push(
      `${result.repos.length} repo${result.repos.length === 1 ? "" : "s"} to declare in the repos roster (dry-run; pass --apply to write):`,
    );
    for (const r of result.repos) lines.push(`- ${r.path}`);
    lines.push("");
    lines.push("Note: visibility is proposed unset; assign it manually after applying.");
  }

  if (result.excluded.length > 0) {
    lines.push("");
    lines.push(
      `## Excluded (${result.excluded.length}) — not a git repo, so not included in repos`,
    );
    for (const e of result.excluded) {
      const reason =
        e.kind === "non-repo"
          ? "not a repo (workspace view / tmp, etc.)"
          : "unresolvable (path does not exist)";
      lines.push(`- ${e.path} — ${reason}`);
    }
  }
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectWiring}. */
export async function runProjectWiring(
  options: ProjectWiringOptions,
  ctx: ProjectWiringContext = {},
): Promise<void> {
  try {
    await doRunProjectWiring(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Whether a repo-relative path is tracked by git in `repoRoot`. `git ls-files`
 * prints the path when it is tracked and nothing when it is not. Any error
 * (missing git, a corrupt repo) propagates; {@link gatherRepoWiring} decides
 * whether to surface it (a missing git executable, which is global) or degrade
 * the single repo to unreachable (a per-repo failure) — never reading the error
 * as a false "untracked".
 */
async function isTrackedByGit(repoRoot: string, relPath: string): Promise<boolean> {
  const out = await safeSimpleGit(repoRoot).raw(["ls-files", "--", relPath]);
  return out.trim().length > 0;
}

/**
 * Gather the on-disk + git facts for one declared repo. Resolves the repo path
 * (realpath) and requires a `.git`; an unresolvable or non-repo path is reported
 * as `reachable: false` rather than crashing the whole report. Presence uses
 * `lstat` so a symlink (even a broken one) still counts as present.
 */
async function gatherRepoWiring(
  repositoryRoot: string,
  entry: RepoEntry,
): Promise<RepoWiringFacts> {
  const base = {
    path: entry.path,
    ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
    ...(instructionMode(entry) === "self" ? { self: true } : {}),
  };
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { ...base, reachable: false, instructionFiles: [] };
  }
  if (!existsSync(join(real, ".git"))) {
    return { ...base, reachable: false, instructionFiles: [] };
  }

  try {
    const instructionFiles: InstructionFileFact[] = [];
    for (const name of INSTRUCTION_FILES) {
      let present = true;
      try {
        lstatSync(join(real, name));
      } catch {
        present = false;
      }
      instructionFiles.push({ name, present, tracked: await isTrackedByGit(real, name) });
    }
    return { ...base, reachable: true, instructionFiles };
  } catch (error: unknown) {
    // A missing git executable is a global, actionable failure — surface it so
    // the whole report does not silently read every repo as "untracked".
    if (isGitNotFound(error)) throw error;
    // A per-repo git failure (a corrupt repo, a stale worktree pointer) degrades
    // only THIS repo to unreachable, so one bad repo cannot blank the report.
    return { ...base, reachable: false, instructionFiles: [] };
  }
}

/**
 * Inspect each declared repo's instruction-file wiring. Resolves the workspace,
 * reads the manifest, gathers per-repo facts (presence + git-tracked status),
 * and summarizes the privacy-relevant drift. Read-only — it generates nothing.
 */
export async function doRunProjectWiring(
  options: ProjectWiringOptions,
  ctx: ProjectWiringContext,
): Promise<ProjectWiringResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project wiring");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const roster = manifest.repos ?? [];
  const facts: RepoWiringFacts[] = [];
  for (const entry of roster) facts.push(await gatherRepoWiring(repositoryRoot, entry));

  const summary = summarizeWiring(facts);
  const result: ProjectWiringResult = { ...summary, hasRoster: roster.length > 0 };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectWiring(result));
  }
  return result;
}

/**
 * Render the wiring report. Leads with the actionable outcome: no roster (run
 * adopt first), the privacy risks (a public repo tracking an instruction file),
 * the unjudgeable repos (visibility unset), and the wiring gaps (missing files).
 * States the read-only framing so the verdict is not over-read.
 */
export function renderProjectWiring(result: ProjectWiringResult): string {
  const lines: string[] = [];
  lines.push(
    "# Instruction-file wiring check (declared roster × instruction-file presence / git tracking)",
  );
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ No repo roster declared (manifest `repos`). Declare one with `basou project adopt`, then re-run.",
    );
    return lines.join("\n");
  }

  if (result.risks.length > 0) {
    lines.push(
      `⚠️ Instruction files tracked by git in public-facing repos: ${result.risks.length} (canonical leak risk)`,
    );
    for (const r of result.risks) {
      lines.push(
        `- ${r.repo} [${r.visibility}] — ${r.file} is tracked (it should be a gitignored symlink)`,
      );
    }
  } else if (result.ok) {
    lines.push(
      "✅ No instruction file is tracked by git in a public-facing repo (no privacy risk).",
    );
  } else {
    // No confirmed risks, but unjudgeable / unreachable repos exist below — do NOT
    // lead with a clean "no risk" verdict (that would be a false-clear).
    lines.push(
      "ℹ️ No confirmed privacy risk, but some repos are unjudgeable / unreachable (see below).",
    );
  }
  lines.push("");

  if (result.unknown.length > 0) {
    lines.push(
      `## Visibility unset (${result.unknown.length}) — privacy cannot be judged. Assign visibility in the manifest repos`,
    );
    for (const p of result.unknown) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.self.length > 0) {
    lines.push(
      `## instructions: self (${result.self.length}) — committed instruction files are intentional (no leak risk)`,
    );
    for (const p of result.self) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.incomplete.length > 0) {
    lines.push(
      `## Missing instruction files (${result.incomplete.length}) — to be filled by a later generation slice`,
    );
    for (const i of result.incomplete) lines.push(`- ${i.repo} — ${i.missing.join(", ")}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(`## Unreachable (${result.unreachable.length}) — path unresolved / not a git repo`);
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "Note: read-only advisory. It only shows instruction-file presence and git-tracking status; it neither generates nor enforces (for the .basou footprint, use `basou view --check`).",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectGitignore}. */
export async function runProjectGitignore(
  options: ProjectGitignoreOptions,
  ctx: ProjectGitignoreContext = {},
): Promise<void> {
  try {
    await doRunProjectGitignore(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Gather one declared repo's `.gitignore` facts. Resolves the repo path
 * (realpath) and requires a `.git`; an unresolvable / non-repo path is reported
 * as `reachable: false`. Reads the repo's `.gitignore` into trimmed-on-compare
 * lines (an empty array when there is none). Pure filesystem reads — no writes.
 */
function gatherRepoGitignore(repositoryRoot: string, entry: RepoEntry): RepoGitignoreFacts {
  const base = {
    path: entry.path,
    ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
    ...(instructionMode(entry) === "self" ? { self: true } : {}),
  };
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { ...base, reachable: false, currentLines: [] };
  }
  if (!existsSync(join(real, ".git"))) {
    return { ...base, reachable: false, currentLines: [] };
  }
  return { ...base, reachable: true, currentLines: readGitignoreLines(join(real, ".gitignore")) };
}

/** True when an error carries a string `code` (a Node errno like `ENOENT`). */
function hasErrorCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

/**
 * Read a `.gitignore` into trimmed-on-compare lines. A genuinely absent file
 * (`ENOENT`) yields `[]`; any OTHER read error is re-thrown with a pathless
 * message (so an unreadable file is never mistaken for "no patterns", which on
 * the apply path would clobber it down to only the generated patterns).
 */
function readGitignoreLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/);
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") return [];
    throw new Error("Failed to read .gitignore", { cause: error });
  }
}

/** Append the planned patterns to a repo's `.gitignore`, creating it if absent. */
function applyGitignorePlan(repositoryRoot: string, plan: RepoGitignorePlan): void {
  const file = join(realpathSync(resolve(repositoryRoot, plan.path)), ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch (error: unknown) {
    if (!(hasErrorCode(error) && error.code === "ENOENT")) {
      // Do NOT clobber an existing-but-unreadable .gitignore with only the patterns.
      throw new Error("Failed to read .gitignore", { cause: error });
    }
  }
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  try {
    writeFileSync(file, `${existing}${sep}${plan.toAdd.join("\n")}\n`);
  } catch (error: unknown) {
    throw new Error("Failed to write .gitignore", { cause: error });
  }
}

/**
 * Reconcile each public-facing repo's `.gitignore` to exclude the agent
 * instruction files. Resolves the workspace, reads the manifest, gathers each
 * declared repo's current `.gitignore`, and plans the missing patterns. When
 * `--apply` is set and there is something to add, it appends the patterns
 * (additive — it never removes a line); otherwise it writes nothing and prints
 * the plan. Private and unset-visibility repos are left untouched.
 */
export async function doRunProjectGitignore(
  options: ProjectGitignoreOptions,
  ctx: ProjectGitignoreContext,
): Promise<ProjectGitignoreResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project gitignore");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const roster = manifest.repos ?? [];
  const facts = roster.map((entry) => gatherRepoGitignore(repositoryRoot, entry));
  const summary = planGitignore({ repos: facts, required: [...INSTRUCTION_FILES] });

  const applied = options.apply === true && summary.plans.length > 0;
  if (applied) {
    for (const plan of summary.plans) applyGitignorePlan(repositoryRoot, plan);
  }

  const result: ProjectGitignoreResult = { ...summary, hasRoster: roster.length > 0, applied };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectGitignore(result));
  }
  return result;
}

/**
 * Render the gitignore report. Leads with the actionable outcome: no roster (run
 * adopt first), the per-repo patterns that will be / were added, then the
 * skipped (unset visibility) and unreachable repos. A clean verdict is shown
 * only when there is genuinely nothing to do AND every repo was judgeable and
 * reachable (no false-clear).
 */
export function renderProjectGitignore(result: ProjectGitignoreResult): string {
  const lines: string[] = [];
  lines.push("# .gitignore generation (exclude instruction files in public-facing repos)");
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ No repo roster declared (manifest `repos`). Declare one with `basou project adopt`, then re-run.",
    );
    return lines.join("\n");
  }

  if (result.plans.length > 0) {
    const verb = result.applied ? "Added to" : "To add to (dry-run; pass --apply to write)";
    lines.push(
      `${result.applied ? "✅ " : ""}${verb} the .gitignore of ${result.plans.length} repo${result.plans.length === 1 ? "" : "s"}:`,
    );
    for (const p of result.plans) lines.push(`- ${p.path} — ${p.toAdd.join(", ")}`);
  } else if (result.ok) {
    lines.push(
      "✅ Public-facing repos already exclude every instruction file in .gitignore (nothing to add).",
    );
  } else {
    lines.push(
      "ℹ️ No public-facing repo needs an addition, but some repos are unjudgeable / unreachable (see below).",
    );
  }
  lines.push("");

  if (result.unknown.length > 0) {
    lines.push(
      `## Visibility unset (${result.unknown.length}) — skipped. Assign visibility in the manifest repos`,
    );
    for (const p of result.unknown) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.self.length > 0) {
    lines.push(
      `## instructions: self (${result.self.length}) — skipped by design; their committed instruction files are shared, never gitignored`,
    );
    for (const p of result.self) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(`## Unreachable (${result.unreachable.length}) — path unresolved / not a git repo`);
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  lines.push(
    "Note: existing .gitignore lines are kept; only the missing patterns are appended (nothing is removed). private / visibility-unset repos are skipped.",
  );
  lines.push(
    "Note: appending to .gitignore does not untrack files already tracked by git. Detect tracked instruction files with `basou project wiring` and remove them with `git rm --cached <file>`.",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectSymlinks}. */
export async function runProjectSymlinks(
  options: ProjectSymlinksOptions,
  ctx: ProjectSymlinksContext = {},
): Promise<void> {
  try {
    await doRunProjectSymlinks(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * The instruction files and their expected symlink targets for one repo, in the
 * hub-and-spoke topology: AGENTS.md is the hub (a relative link to the anchor's
 * canonical), while CLAUDE.md and Copilot are spokes pointing back at the repo's
 * own AGENTS.md. `repoDirReal` and `canonicalFile` are both realpath-resolved so
 * the computed relative target matches a hand-wired link byte-for-byte.
 *
 * A `self` repo (`mode === "self"`) owns its AGENTS.md as a regular committed
 * file, so the AGENTS.md hub link is omitted — only the two spokes are returned
 * (their targets are identical to the hub case: each points at the repo's own
 * AGENTS.md). `canonicalFile` is then unused.
 */
function expectedSymlinkTargets(
  repoDirReal: string,
  canonicalFile: string,
  mode: RepoInstructions = "hub",
): { name: string; target: string }[] {
  const spokes = [
    { name: "CLAUDE.md", target: CANONICAL_FILE },
    { name: ".github/copilot-instructions.md", target: `../${CANONICAL_FILE}` },
  ];
  if (mode === "self") return spokes;
  return [{ name: "AGENTS.md", target: relative(repoDirReal, canonicalFile) }, ...spokes];
}

/**
 * Inspect one instruction file's on-disk state against the link it should be.
 * `lstat` examines a symlink as a link (even a broken one), never following it.
 * Only a genuinely absent path (ENOENT) is `missing` (a creatable gap); any other
 * lstat error (ENOTDIR when a parent component is a regular file, EACCES) is
 * `blocked` — NOT `missing` — so a non-ENOENT error is never mistaken for a gap
 * and planned, which would crash `--apply` (e.g. `mkdirSync` over a `.github`
 * file). A symlink is `correct` when it points at `expectedTarget` and `mismatch`
 * (carrying its current target) otherwise; a real file or directory is `occupied`.
 */
function inspectSymlink(
  filePath: string,
  expectedTarget: string,
): { state: InstructionSymlinkState; actualTarget?: string } {
  let isLink: boolean;
  try {
    isLink = lstatSync(filePath).isSymbolicLink();
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") return { state: "missing" };
    return { state: "blocked" };
  }
  if (!isLink) return { state: "occupied" };
  const actual = readlinkSync(filePath);
  return actual === expectedTarget
    ? { state: "correct" }
    : { state: "mismatch", actualTarget: actual };
}

/**
 * Gather the symlink facts for one declared repo. Resolves the repo path
 * (realpath); the entry that resolves to the manifest root IS the anchor (it
 * owns the canonical, so it is flagged `isAnchor` and never linked to itself). A
 * path that does not resolve or has no `.git` is `reachable: false`. Otherwise it
 * checks whether the anchor's canonical (`agents/<repo>/AGENTS.md`) exists and,
 * if so, inspects each instruction file's current state. Pure filesystem reads —
 * no writes.
 */
function gatherRepoSymlinks(
  repositoryRoot: string,
  anchorReal: string,
  entry: RepoEntry,
): RepoSymlinkFacts {
  const mode = instructionMode(entry);
  const isSelf = mode === "self";
  const base = { path: entry.path, ...(isSelf ? { self: true } : {}) };
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { ...base, isAnchor: false, reachable: false, canonicalPresent: false, files: [] };
  }
  if (real === anchorReal) {
    // The anchor hosts the OTHER repos' hub canonicals (agents/<repo>/AGENTS.md),
    // but its OWN AGENTS.md is a regular committed file at the anchor root — the
    // same shape as a `self` repo. So it is wired like `self`: only the CLAUDE.md
    // / Copilot spokes are generated (pointing at the root AGENTS.md); the
    // AGENTS.md hub link is never created (it IS the canonical). The spokes are
    // wired only once that root AGENTS.md exists (seeded by `derive`, or
    // hand-authored); an absent one means the spokes would dangle, so none are
    // planned (canonicalPresent: false → the anchor is left alone until it is
    // seeded, then a re-run wires the spokes).
    const anchorCanonical = join(real, CANONICAL_FILE);
    if (!existsSync(anchorCanonical)) {
      return { ...base, isAnchor: true, reachable: true, canonicalPresent: false, files: [] };
    }
    const anchorFiles: InstructionSymlinkFact[] = expectedSymlinkTargets(
      real,
      anchorCanonical,
      "self",
    ).map((spec) => {
      const { state, actualTarget } = inspectSymlink(join(real, spec.name), spec.target);
      return {
        name: spec.name,
        expectedTarget: spec.target,
        state,
        ...(actualTarget !== undefined ? { actualTarget } : {}),
      };
    });
    return {
      ...base,
      isAnchor: true,
      reachable: true,
      canonicalPresent: true,
      canonicalName: basename(real),
      files: anchorFiles,
    };
  }
  if (!existsSync(join(real, ".git"))) {
    return { ...base, isAnchor: false, reachable: false, canonicalPresent: false, files: [] };
  }

  // For a `self` repo the canonical IS the repo's own committed AGENTS.md (only
  // the spokes are generated, pointing back at it); for a `hub` repo it is the
  // anchor's `agents/<repo>/AGENTS.md`. Either way an absent canonical means the
  // links would dangle, so none are planned (summarize routes the two cases to
  // `selfAgentsMissing` / `missingCanonical` respectively).
  const canonicalFile = isSelf
    ? join(real, CANONICAL_FILE)
    : join(anchorReal, "agents", basename(real), CANONICAL_FILE);
  if (!existsSync(canonicalFile)) {
    return { ...base, isAnchor: false, reachable: true, canonicalPresent: false, files: [] };
  }

  const files: InstructionSymlinkFact[] = expectedSymlinkTargets(real, canonicalFile, mode).map(
    (spec) => {
      const { state, actualTarget } = inspectSymlink(join(real, spec.name), spec.target);
      return {
        name: spec.name,
        expectedTarget: spec.target,
        state,
        ...(actualTarget !== undefined ? { actualTarget } : {}),
      };
    },
  );
  return {
    ...base,
    isAnchor: false,
    reachable: true,
    canonicalPresent: true,
    canonicalName: basename(real),
    files,
  };
}

/**
 * Create the planned (missing) symlinks for one repo, making `.github` if needed.
 * Defensive: a per-file failure (a path made unwritable, a parent that is not a
 * directory, or a race that created the file first) is collected, not thrown — so
 * one bad path neither aborts the remaining repos nor leaves the run silent about
 * what was actually created (upholding the non-destructive contract transparently).
 */
function applySymlinkPlan(
  repositoryRoot: string,
  plan: RepoSymlinkPlan,
): { created: string[]; failed: { file: string; message: string }[] } {
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, plan.path));
  } catch (error: unknown) {
    const message = failureReason(error);
    return { created: [], failed: plan.toCreate.map((c) => ({ file: c.name, message })) };
  }
  const created: string[] = [];
  const failed: { file: string; message: string }[] = [];
  for (const { name, target } of plan.toCreate) {
    const filePath = join(real, name);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      symlinkSync(target, filePath);
      created.push(name);
    } catch (error: unknown) {
      failed.push({ file: name, message: failureReason(error) });
    }
  }
  return { created, failed };
}

/**
 * A pathless failure reason for `--apply` errors: the errno code (EEXIST,
 * ENOTDIR, EACCES, …) when present, else a generic label. Never the raw Node
 * `error.message`, which embeds the absolute filesystem path and would leak it
 * into the report / `--json` output (the repo + repo-relative file already
 * identify the failure).
 */
function failureReason(error: unknown): string {
  return hasErrorCode(error) ? error.code : "unknown error";
}

/**
 * The workspace-view ↔ roster canonical-name collision guard shared by preset /
 * symlinks / retrofit. When the view directory's basename equals a roster repo's
 * resolved canonical name, BOTH would own the same `agents/<name>/AGENTS.md`, so
 * generating either side would clobber the other — every view generator refuses
 * and surfaces the collision instead. Canonical names follow the repo-preset
 * rule (realpath basename, falling back to the plain resolved basename when the
 * path does not resolve). Returns the first colliding roster repo's declared
 * path, or undefined when the view name is unique.
 */
function viewCanonicalCollision(
  repositoryRoot: string,
  roster: RepoEntry[],
  viewName: string,
): string | undefined {
  for (const entry of roster) {
    let name: string;
    try {
      name = basename(realpathSync(resolve(repositoryRoot, entry.path)));
    } catch {
      name = basename(resolve(repositoryRoot, entry.path));
    }
    if (name === viewName) return entry.path;
  }
  return undefined;
}

/**
 * Gather the workspace view's OWN instruction-symlink facts. The view is wired
 * exactly like a `hub` repo — AGENTS.md → the anchor canonical
 * (`agents/<viewName>/AGENTS.md`), CLAUDE.md → AGENTS.md, Copilot → ../AGENTS.md —
 * but it is a git-unmanaged directory, so the `.git` check {@link gatherRepoSymlinks}
 * performs is skipped. The caller resolves the view directory ONCE and threads it
 * here and into the apply step. A view name shared with a roster repo's canonical
 * is a `collision` (nothing wired); when the view canonical does not exist yet
 * (preset runs first), nothing is wired (`missing-canonical`). Pure filesystem
 * reads.
 */
function gatherViewSymlinks(
  repositoryRoot: string,
  anchorReal: string,
  roster: RepoEntry[],
  viewDir: string,
): ViewSymlinksOutcome {
  const viewName = basename(viewDir);
  const collision = viewCanonicalCollision(repositoryRoot, roster, viewName);
  if (collision !== undefined) return { kind: "collision", viewName, repoPath: collision };
  const canonicalFile = canonicalFileFor(anchorReal, viewName);
  if (!existsSync(canonicalFile)) return { kind: "missing-canonical", viewName };

  const files: InstructionSymlinkFact[] = expectedSymlinkTargets(viewDir, canonicalFile, "hub").map(
    (spec) => {
      const { state, actualTarget } = inspectSymlink(join(viewDir, spec.name), spec.target);
      return {
        name: spec.name,
        expectedTarget: spec.target,
        state,
        ...(actualTarget !== undefined ? { actualTarget } : {}),
      };
    },
  );
  return { kind: "gathered", viewName, files };
}

/**
 * Create the view's MISSING instruction links (making `.github` if needed). Only a
 * `missing` spoke is created — a `correct` link is skipped, and a `mismatch` /
 * `occupied` / `blocked` entry is left untouched (non-destructive, mirroring
 * {@link applySymlinkPlan}). Failures are collected, not thrown.
 *
 * The recursive `mkdir` deliberately creates the view directory itself when it
 * does not exist yet (not just `.github`): the symlinks step must be runnable
 * standalone, without the workspace step (which also creates the view dir)
 * having run first. The two steps intentionally share view-dir creation — the
 * double ownership is a design choice, not an oversight.
 */
function applyViewSymlinks(
  viewDir: string,
  files: InstructionSymlinkFact[],
): { created: string[]; failed: { file: string; message: string }[] } {
  const created: string[] = [];
  const failed: { file: string; message: string }[] = [];
  for (const f of files) {
    if (f.state !== "missing") continue;
    const filePath = join(viewDir, f.name);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      symlinkSync(f.expectedTarget, filePath);
      created.push(f.name);
    } catch (error: unknown) {
      failed.push({ file: f.name, message: failureReason(error) });
    }
  }
  return { created, failed };
}

/**
 * Generate each declared repo's instruction-file symlinks. Resolves the
 * workspace, reads the manifest, gathers each repo's current symlink state, and
 * plans the missing links. When `--apply` is set and there is something to
 * create, it creates only the `missing` links (non-destructive — conflicts and
 * occupied paths are never touched); otherwise it writes nothing and prints the
 * plan.
 */
export async function doRunProjectSymlinks(
  options: ProjectSymlinksOptions,
  ctx: ProjectSymlinksContext,
): Promise<ProjectSymlinksResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project symlinks");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const roster = manifest.repos ?? [];
  const anchorReal = realpathSync(repositoryRoot);
  const facts = roster.map((entry) => gatherRepoSymlinks(repositoryRoot, anchorReal, entry));
  const summary = summarizeSymlinkPlan(facts);

  const wantApply = options.apply === true && summary.plans.length > 0;
  const failures: { repo: string; file: string; message: string }[] = [];
  let createdCount = 0;
  if (wantApply) {
    for (const plan of summary.plans) {
      const { created, failed } = applySymlinkPlan(repositoryRoot, plan);
      createdCount += created.length;
      for (const f of failed) failures.push({ repo: plan.path, file: f.file, message: f.message });
    }
  }

  // The workspace view's own instruction spokes, wired like a hub repo into the
  // view directory (its canonical was created by preset, which derive runs first).
  // An empty roster skips the view entirely (`view` stays absent): the run is
  // then a whole no-op, so nothing may be inspected or written into the view.
  let view: ViewSymlinksOutcome | undefined;
  let viewCreated: string[] = [];
  const viewFailures: { file: string; message: string }[] = [];
  if (roster.length > 0) {
    const viewPath = manifest.workspace.view;
    if (viewPath === undefined) {
      view = { kind: "no-view" };
    } else {
      // Resolve the view dir ONCE and thread it into both gather and apply, so
      // `--apply` writes into exactly the directory that was inspected.
      const viewDir = resolveViewDir(repositoryRoot, viewPath);
      view = gatherViewSymlinks(repositoryRoot, anchorReal, roster, viewDir);
      if (options.apply === true && view.kind === "gathered") {
        const { created, failed } = applyViewSymlinks(viewDir, view.files);
        viewCreated = created;
        for (const f of failed) viewFailures.push(f);
      }
    }
  }

  // The view is a second wiring target, so `ok`'s no-false-clear contract must
  // include it: clean = absent (empty roster), no view declared, or every spoke
  // already `correct`. A spoke to create, a conflicted spoke, a missing view
  // canonical, or a name collision all deny the clean verdict (mirroring
  // `SymlinkPlanSummary.ok`, which conflicts and collisions also break).
  const viewClean =
    view === undefined ||
    view.kind === "no-view" ||
    (view.kind === "gathered" && view.files.every((f) => f.state === "correct"));

  const result: ProjectSymlinksResult = {
    ...summary,
    ok: summary.ok && viewClean,
    hasRoster: roster.length > 0,
    applied: createdCount > 0,
    failures,
    ...(view !== undefined ? { view } : {}),
    viewCreated,
    viewFailures,
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectSymlinks(result));
  }
  return result;
}

/**
 * Render the symlink-generation report. Leads with the actionable outcome: no
 * roster (run adopt first), the per-repo links that will be / were created, then
 * the conflicts (existing files / links pointing elsewhere — left untouched),
 * repos whose anchor canonical is absent, and unreachable repos. A clean "all
 * wired" verdict is shown only when there is genuinely nothing to do AND every
 * repo was judgeable and reachable (no false-clear).
 */
export function renderProjectSymlinks(result: ProjectSymlinksResult): string {
  const lines: string[] = [];
  lines.push("# Instruction-file symlink generation (each repo → the anchor's canonical)");
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ No repo roster declared (manifest `repos`). Declare one with `basou project adopt`, then re-run.",
    );
    return lines.join("\n");
  }

  if (result.plans.length > 0) {
    // `--apply` was attempted when something was created OR something failed; a
    // dry-run has neither (its plan is just intentions, written nowhere).
    const attempted = result.applied || result.failures.length > 0;
    if (!attempted) {
      lines.push(
        `Instruction-file symlinks to create in ${result.plans.length} repo${result.plans.length === 1 ? "" : "s"} (dry-run; pass --apply to write):`,
      );
      for (const p of result.plans) {
        lines.push(`- ${p.path}`);
        for (const c of p.toCreate) lines.push(`    ${c.name} -> ${c.target}`);
      }
    } else {
      // List only what was ACTUALLY created — a planned file that failed appears
      // in the failures section, never here (no false "created" claim).
      const header =
        result.failures.length === 0
          ? "✅ Created instruction-file symlinks:"
          : result.applied
            ? "Created instruction-file symlinks (some failed, see below):"
            : "Could not create instruction-file symlinks (see below):";
      lines.push(header);
      for (const p of result.plans) {
        const failedFiles = new Set(
          result.failures.filter((f) => f.repo === p.path).map((f) => f.file),
        );
        const created = p.toCreate.filter((c) => !failedFiles.has(c.name));
        if (created.length === 0) continue;
        lines.push(`- ${p.path}`);
        for (const c of created) lines.push(`    ${c.name} -> ${c.target}`);
      }
    }
  } else if (result.ok) {
    lines.push(
      "✅ Every declared repo's instruction-file symlinks are correctly wired (nothing to generate).",
    );
  } else {
    lines.push(
      "ℹ️ No repo symlink needs generating, but there are conflicts / collisions / a missing canonical / unreachable repos, or the workspace view's spokes need attention (see below).",
    );
  }
  lines.push("");

  if (result.failures.length > 0) {
    lines.push(
      `## Creation failed (${result.failures.length}) — some symlinks could not be created`,
    );
    for (const f of result.failures) lines.push(`- ${f.repo} — ${f.file}: ${f.message}`);
    lines.push("");
  }

  if (result.conflicts.length > 0) {
    lines.push(
      `## Conflicts (${result.conflicts.length}) — existing entries are not overwritten. Check them manually`,
    );
    for (const c of result.conflicts) {
      const detail =
        c.reason === "mismatch"
          ? `a symlink pointing elsewhere (currently: ${c.actualTarget ?? "?"})`
          : c.reason === "occupied"
            ? "a real file/directory, not a symlink"
            : "an uninspectable path (a parent component is not a directory, etc.)";
      lines.push(`- ${c.repo} — ${c.file}: ${detail}`);
    }
    lines.push("");
  }

  if (result.collisions.length > 0) {
    lines.push(
      `## Canonical collisions (${result.collisions.length}) — another repo shares the same-named canonical (not auto-wired)`,
    );
    for (const c of result.collisions) {
      lines.push(`- agents/${c.canonicalName}/AGENTS.md ← ${c.repos.join(", ")}`);
    }
    lines.push("");
  }

  if (result.missingCanonical.length > 0) {
    lines.push(
      `## Canonical missing (${result.missingCanonical.length}) — the anchor has no agents/<repo>/AGENTS.md, so nothing can be generated`,
    );
    for (const p of result.missingCanonical) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.selfAgentsMissing.length > 0) {
    lines.push(
      `## AGENTS.md missing (${result.selfAgentsMissing.length}) — these \`instructions: self\` repos have no committed AGENTS.md yet; author it, then re-run to wire the spokes`,
    );
    for (const p of result.selfAgentsMissing) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(`## Unreachable (${result.unreachable.length}) — path unresolved / not a git repo`);
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  appendViewSymlinksSection(lines, result);

  lines.push(
    "Note: an existing file or a symlink pointing elsewhere is never overwritten; only the missing links are created (GEMINI.md is discontinued and not generated).",
  );
  return lines.join("\n");
}

/**
 * Append the workspace-view's own instruction-symlink section: the AGENTS.md /
 * CLAUDE.md / Copilot spokes wired into the view directory. It is a second target
 * (not a roster repo), so it is reported separately from the per-repo links. No
 * `workspace.view` declared prints nothing.
 */
function appendViewSymlinksSection(lines: string[], result: ProjectSymlinksResult): void {
  const view = result.view;
  if (view === undefined || view.kind === "no-view") return;
  lines.push("## Workspace view spokes (the view's own instruction files)");
  if (view.kind === "collision") {
    lines.push(
      `⚠️ ${view.viewName}: the view shares its canonical name with the roster repo \`${view.repoPath}\` — both would own \`agents/${view.viewName}/${CANONICAL_FILE}\`, so no view spoke is wired. Rename the view directory or the repo to disambiguate, then re-run.`,
    );
    lines.push("");
    return;
  }
  if (view.kind === "missing-canonical") {
    lines.push(
      `ℹ️ ${view.viewName}: the view canonical \`agents/${view.viewName}/${CANONICAL_FILE}\` does not exist yet — run \`basou project preset --apply\` first (or \`basou project derive --apply\`), then re-run.`,
    );
    lines.push("");
    return;
  }
  const failedFiles = new Set(result.viewFailures.map((f) => f.file));
  const missing = view.files.filter((f) => f.state === "missing");
  const attempted = result.viewCreated.length > 0 || result.viewFailures.length > 0;
  if (missing.length === 0) {
    lines.push(`✅ ${view.viewName}: the view's instruction spokes are correctly wired.`);
  } else if (!attempted) {
    lines.push(`${view.viewName}: view spokes to create (dry-run; pass --apply to write):`);
    for (const f of missing) lines.push(`    ${f.name} -> ${f.expectedTarget}`);
  } else {
    lines.push(`${view.viewName}: view spokes created:`);
    for (const f of missing) {
      if (failedFiles.has(f.name)) continue;
      lines.push(`    ${f.name} -> ${f.expectedTarget}`);
    }
  }
  if (result.viewFailures.length > 0) {
    lines.push(`  Failed:`);
    for (const f of result.viewFailures) lines.push(`    ${f.file}: ${f.message}`);
  }
  // Conflicts (mismatch/occupied/blocked) are surfaced so the operator sees why a
  // spoke was not wired.
  const conflicts = view.files.filter(
    (f) => f.state === "mismatch" || f.state === "occupied" || f.state === "blocked",
  );
  if (conflicts.length > 0) {
    lines.push(`  Conflicts (left untouched):`);
    for (const f of conflicts) {
      const detail =
        f.state === "mismatch"
          ? `points elsewhere (currently: ${f.actualTarget ?? "?"})`
          : f.state === "occupied"
            ? "a real file/directory"
            : "an uninspectable path";
      lines.push(`    ${f.name}: ${detail}`);
    }
  }
  lines.push("");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectWorkspace}. */
export async function runProjectWorkspace(
  options: ProjectWorkspaceOptions,
  ctx: ProjectWorkspaceContext = {},
): Promise<void> {
  try {
    await doRunProjectWorkspace(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Resolve the view directory to a realpath-stable absolute path. When the view
 * exists, realpath it; when it does not exist yet, anchor on its (existing)
 * parent's realpath + basename so the relative targets computed against the
 * realpath'd repos stay consistent. Falls back to the plain resolved path only
 * when the parent is also absent (apply's recursive mkdir will create it).
 */
function resolveViewDir(repositoryRoot: string, viewPath: string): string {
  const abs = resolve(repositoryRoot, viewPath);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * Gather one roster repo's place in the view. Resolves the repo (realpath); an
 * unresolvable path is `reachable: false` (cannot be aggregated). The view link
 * is named by the repo's basename and should point at the repo relative to the
 * view; its on-disk state is inspected with the same ENOENT-only rule as the
 * instruction symlinks (a non-ENOENT lstat error is `blocked`, never a creatable
 * gap). Pure filesystem reads — no writes.
 */
function gatherViewRepo(repositoryRoot: string, viewDir: string, entry: RepoEntry): ViewRepoFact {
  let repoReal: string;
  try {
    repoReal = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { path: entry.path, reachable: false };
  }
  const expectedTarget = relative(viewDir, repoReal);
  // A repo that resolves to the view directory ITSELF yields an empty (self-)
  // target. It cannot be aggregated into the view, and an empty symlink target
  // would create a broken link that a later run reads back as falsely "correct"
  // (readlink "" === expectedTarget "") — so surface it as unreachable instead.
  if (expectedTarget === "" || expectedTarget === ".") {
    return { path: entry.path, reachable: false };
  }
  const linkName = basename(repoReal);
  const { state, actualTarget } = inspectSymlink(join(viewDir, linkName), expectedTarget);
  return {
    path: entry.path,
    reachable: true,
    linkName,
    expectedTarget,
    state,
    ...(actualTarget !== undefined ? { actualTarget } : {}),
  };
}

/** Create the planned (missing) view symlinks, making the view directory if needed. */
function applyViewPlan(
  viewDir: string,
  toCreate: { name: string; target: string }[],
): { created: string[]; failed: { name: string; message: string }[] } {
  const created: string[] = [];
  const failed: { name: string; message: string }[] = [];
  for (const { name, target } of toCreate) {
    const filePath = join(viewDir, name);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      symlinkSync(target, filePath);
      created.push(name);
    } catch (error: unknown) {
      failed.push({ name, message: failureReason(error) });
    }
  }
  return { created, failed };
}

/** Top-level instruction-file names the view may hold for itself — never treated as strays (case-insensitive). */
const TOP_LEVEL_INSTRUCTION_FILES_LOWER: ReadonlySet<string> = new Set(
  INSTRUCTION_FILES.filter((f) => !f.includes("/")).map((f) => f.toLowerCase()),
);

/**
 * Classify one view entry by name for stray detection. Returns `null` when the
 * entry is NOT a removable stray candidate — it is not a symlink (a real file/dir
 * is never ours to remove), it vanished, or its target resolves to a CURRENT
 * roster repo (owned by the roster under whatever name — an aliased/symlinked
 * roster path, or a different-case link on a case-insensitive filesystem — so it
 * must never be pruned). Otherwise returns the link's target and `kind`: `repo`
 * (a relative target following to a git repository — a dir holding a `.git` entry,
 * matching the project family's `existsSync(<dir>/.git)` repo test, so worktrees /
 * submodules count); `absolute` (basou never writes absolute view links); `broken`
 * (a relative target that does not resolve); or `non-repo` (resolves to a file or a
 * non-repository directory). Pure filesystem reads — the single source of truth for
 * both the scan and the pre-unlink re-verification.
 */
function classifyViewLink(
  viewDir: string,
  name: string,
  rosterRealpaths: ReadonlySet<string>,
): { target: string; kind: ExistingViewLink["kind"] } | null {
  const filePath = join(viewDir, name);
  let isLink: boolean;
  try {
    isLink = lstatSync(filePath).isSymbolicLink();
  } catch {
    return null; // vanished between readdir and lstat, or not inspectable
  }
  if (!isLink) return null; // a real file/dir is never ours to prune
  let target: string;
  try {
    target = readlinkSync(filePath);
  } catch {
    return null;
  }
  // A link pointing at a CURRENT roster repo (by resolved identity, not name) is
  // the repo's own link, never a stray — even under an aliased name, a case-folded
  // spelling, OR an absolute target. realpath canonicalizes all three. This
  // ownership check precedes the absolute/relative classification so an absolute
  // link to a rostered repo is treated as owned (not surfaced as a stray).
  const resolved = isAbsolute(target) ? target : resolve(viewDir, target);
  try {
    if (rosterRealpaths.has(realpathSync(resolved))) return null;
  } catch {
    // unresolvable target → not a roster repo; fall through to classify
  }
  if (isAbsolute(target)) return { target, kind: "absolute" }; // basou writes only relative links
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory(); // follows the link
  } catch {
    isDir = false; // ENOENT / unreadable → broken
  }
  if (!isDir) {
    // Resolves to a file (e.g. an instruction symlink) or not at all — not a repo.
    return { target, kind: existsSync(resolved) ? "non-repo" : "broken" };
  }
  return { target, kind: existsSync(join(resolved, ".git")) ? "repo" : "non-repo" };
}

/**
 * Scan the view directory for stray-detection candidates: its top-level SYMLINK
 * entries, classified by {@link classifyViewLink}. The view's own top-level
 * instruction-file symlinks (`AGENTS.md`/`CLAUDE.md`, matched case-insensitively)
 * and links resolving to a current roster repo are skipped. An ABSENT view
 * directory (ENOENT — nothing generated yet) yields `[]`; any other readdir error
 * (the view path is a file, or is unreadable) is surfaced, never read as "no
 * strays" (no false-clear). Pure reads.
 */
export function gatherExistingViewLinks(
  viewDir: string,
  rosterRealpaths: ReadonlySet<string>,
): ExistingViewLink[] {
  let names: string[];
  try {
    names = readdirSync(viewDir);
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") return []; // not generated yet
    // The view path exists but could not be scanned (a regular file, EACCES, …) —
    // surface it rather than silently reporting a clean, stray-free view. The
    // message is path-less (matching the file's other thrown errors); the absolute
    // path stays in `cause`, shown only under --verbose.
    throw new Error("Cannot scan the workspace view (check the path / its type)", {
      cause: error,
    });
  }
  const links: ExistingViewLink[] = [];
  for (const name of names) {
    if (TOP_LEVEL_INSTRUCTION_FILES_LOWER.has(name.toLowerCase())) continue; // the view's own instruction file
    const c = classifyViewLink(viewDir, name, rosterRealpaths);
    if (c === null) continue;
    links.push({ name, target: c.target, kind: c.kind });
  }
  return links;
}

/**
 * Remove the planned stray view symlinks. Immediately before each `unlinkSync` it
 * RE-DERIVES the full prune predicate via {@link classifyViewLink} (still a symlink,
 * still a relative target following to a git repo the roster does not back) and
 * skips with a collected failure if anything changed since the scan — closing the
 * scan-to-unlink window for this first file-removing operation. It only ever
 * unlinks the link, never its target. Failures are collected, not thrown.
 */
export function pruneViewLinks(
  viewDir: string,
  toPrune: { name: string; target: string }[],
  rosterRealpaths: ReadonlySet<string>,
): { pruned: string[]; failed: { name: string; message: string }[] } {
  const pruned: string[] = [];
  const failed: { name: string; message: string }[] = [];
  for (const { name } of toPrune) {
    const filePath = join(viewDir, name);
    const c = classifyViewLink(viewDir, name, rosterRealpaths);
    if (c === null || c.kind !== "repo") {
      failed.push({
        name,
        message:
          "the target changed since the scan (no longer a basou-generated stray repo link; re-run)",
      });
      continue;
    }
    try {
      unlinkSync(filePath);
      pruned.push(name);
    } catch (error: unknown) {
      failed.push({ name, message: failureReason(error) });
    }
  }
  return { pruned, failed };
}

/**
 * Generate the project's workspace view and reconcile its strays. Resolves the
 * workspace, reads the manifest, and — when `workspace.view` is declared — gathers
 * each roster repo's view-link state plus the view's existing symlink entries, and
 * plans the missing links to create and the stray repo links to prune. When
 * `--apply` is set it creates only the `missing` links (non-destructive — conflicts
 * and collisions are never touched). When `--prune` is set it removes only the
 * confirmed stray repo links (a symlink whose relative target follows to a git
 * repository the roster no longer backs); unrecognized strays are reported, never
 * removed, and pruning is WITHHELD entirely while any declared repo is unreachable
 * (its live link could be indistinguishable from a stray). The two writes are
 * independent opt-ins; with neither flag it writes nothing and prints the plan.
 * After the writes the verdict (`ok`) is recomputed from the residual state so a
 * fully successful run is not reported as still needing attention.
 */
export async function doRunProjectWorkspace(
  options: ProjectWorkspaceOptions,
  ctx: ProjectWorkspaceContext,
): Promise<ProjectWorkspaceResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project workspace");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const viewPath = manifest.workspace.view;
  const roster = manifest.repos ?? [];

  let result: ProjectWorkspaceResult;
  if (viewPath === undefined) {
    result = {
      toCreate: [],
      conflicts: [],
      collisions: [],
      unreachable: [],
      toPrune: [],
      strayUnknown: [],
      correctCount: 0,
      ok: true,
      hasView: false,
      applied: false,
      pruned: false,
      pruneWithheld: false,
      failures: [],
      pruneFailures: [],
    };
  } else {
    const viewDir = resolveViewDir(repositoryRoot, viewPath);
    const facts = roster.map((entry) => gatherViewRepo(repositoryRoot, viewDir, entry));
    // Ownership inputs for stray detection, computed once and shared by the scan
    // and the pre-unlink re-verification: the basename every declared entry would
    // own (reachability-INDEPENDENT, so a transiently-unreachable repo still owns
    // its link name), and the resolved identity of every repo that DOES resolve
    // (so a link reaching a roster repo under any name/case is never a stray).
    const rosterNames = roster.map((entry) => basename(resolve(repositoryRoot, entry.path)));
    const rosterRealpaths = new Set<string>();
    for (const entry of roster) {
      try {
        rosterRealpaths.add(realpathSync(resolve(repositoryRoot, entry.path)));
      } catch {
        // unreachable repo — protected by name via rosterNames + the prune withhold
      }
    }
    const existing = gatherExistingViewLinks(viewDir, rosterRealpaths);
    const plan = planWorkspaceView(facts, existing, rosterNames);

    const failures: { name: string; message: string }[] = [];
    let createdCount = 0;
    if (options.apply === true && plan.toCreate.length > 0) {
      const applied = applyViewPlan(viewDir, plan.toCreate);
      createdCount = applied.created.length;
      for (const f of applied.failed) failures.push(f);
    }

    // Refuse to prune while any declared repo is unreachable: such a repo's live
    // link can be indistinguishable from a stray, and a false delete is the worst
    // outcome for the family's first file-removing operation. The operator resolves
    // reachability (clone/mount the repo, or `archive` it) and re-runs.
    const pruneWithheld =
      options.prune === true && plan.toPrune.length > 0 && plan.unreachable.length > 0;
    const pruneFailures: { name: string; message: string }[] = [];
    let prunedCount = 0;
    if (options.prune === true && plan.toPrune.length > 0 && plan.unreachable.length === 0) {
      const removed = pruneViewLinks(viewDir, plan.toPrune, rosterRealpaths);
      prunedCount = removed.pruned.length;
      for (const f of removed.failed) pruneFailures.push(f);
    }

    // The plan's `ok` was computed BEFORE the writes; recompute the residual so a
    // create/prune that fully succeeded no longer counts as outstanding work (no
    // false "items need attention" after a successful run).
    const createsOutstanding =
      plan.toCreate.length > 0 && !(options.apply === true && failures.length === 0);
    const prunesOutstanding =
      plan.toPrune.length > 0 &&
      !(options.prune === true && !pruneWithheld && pruneFailures.length === 0);
    const ok =
      plan.conflicts.length === 0 &&
      plan.collisions.length === 0 &&
      plan.unreachable.length === 0 &&
      plan.strayUnknown.length === 0 &&
      !createsOutstanding &&
      !prunesOutstanding;

    result = {
      ...plan,
      ok,
      hasView: true,
      applied: createdCount > 0,
      pruned: prunedCount > 0,
      pruneWithheld,
      failures,
      pruneFailures,
    };
  }

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectWorkspace(result));
  }
  return result;
}

/**
 * Render the workspace-view report. Leads with the actionable outcome: no view
 * declared, the links that will be / were created, the stray repo links that will
 * be / were pruned, then conflicts, basename collisions, unreachable repos, and
 * the unrecognized strays left untouched. A clean "in sync" verdict is shown only
 * when there is genuinely nothing to do, every repo was resolvable and unambiguous,
 * and the view carries no stray (no false-clear).
 */
export function renderProjectWorkspace(result: ProjectWorkspaceResult): string {
  const lines: string[] = [];
  lines.push("# workspace view generation (aggregate the roster repos)");
  lines.push("");

  if (!result.hasView) {
    lines.push(
      "ℹ️ No view declared (manifest `workspace.view`). Declare the aggregation directory, then re-run.",
    );
    return lines.join("\n");
  }

  if (result.toCreate.length > 0) {
    const attempted = result.applied || result.failures.length > 0;
    if (!attempted) {
      lines.push(
        `Repo symlinks to create in the view: ${result.toCreate.length} (dry-run; pass --apply to write):`,
      );
      for (const c of result.toCreate) lines.push(`    ${c.name} -> ${c.target}`);
    } else {
      const failed = new Set(result.failures.map((f) => f.name));
      const header =
        result.failures.length === 0
          ? "✅ Created repo symlinks in the view:"
          : result.applied
            ? "Created repo symlinks in the view (some failed, see below):"
            : "Could not create repo symlinks in the view (see below):";
      lines.push(header);
      for (const c of result.toCreate) {
        if (failed.has(c.name)) continue;
        lines.push(`    ${c.name} -> ${c.target}`);
      }
    }
  } else if (result.ok) {
    lines.push(
      `✅ The view aggregates the entire declared roster (${result.correctCount} links; nothing to generate).`,
    );
  } else {
    lines.push(
      "ℹ️ No symlink needs creating, but there are items needing attention (stray / conflict / collision / unreachable repo, see below).",
    );
  }
  lines.push("");

  if (result.failures.length > 0) {
    lines.push(
      `## Creation failed (${result.failures.length}) — some symlinks could not be created`,
    );
    for (const f of result.failures) lines.push(`- ${f.name}: ${f.message}`);
    lines.push("");
  }

  if (result.toPrune.length > 0) {
    const attempted = result.pruned || result.pruneFailures.length > 0;
    if (result.pruneWithheld) {
      lines.push(
        `${result.toPrune.length} stray repo symlink${result.toPrune.length === 1 ? "" : "s"} were due to be pruned, but pruning was withheld because some repos are unreachable (an unreachable repo's link cannot be told apart from a stray; resolve or archive the repos below, then re-run):`,
      );
      for (const p of result.toPrune) lines.push(`    ${p.name} -> ${p.target}`);
    } else if (!attempted) {
      lines.push(
        `Stray repo symlinks to prune: ${result.toPrune.length} (dry-run; pass --prune to remove):`,
      );
      for (const p of result.toPrune) lines.push(`    ${p.name} -> ${p.target}`);
    } else {
      const failed = new Set(result.pruneFailures.map((f) => f.name));
      const header =
        result.pruneFailures.length === 0
          ? "🧹 Pruned stray repo symlinks:"
          : result.pruned
            ? "Pruned stray repo symlinks (some failed, see below):"
            : "Could not prune stray repo symlinks (see below):";
      lines.push(header);
      for (const p of result.toPrune) {
        if (failed.has(p.name)) continue;
        lines.push(`    ${p.name} -> ${p.target}`);
      }
    }
    lines.push("");
  }

  if (result.pruneFailures.length > 0) {
    lines.push(
      `## Pruning failed (${result.pruneFailures.length}) — some stray symlinks could not be pruned`,
    );
    for (const f of result.pruneFailures) lines.push(`- ${f.name}: ${f.message}`);
    lines.push("");
  }

  if (result.conflicts.length > 0) {
    lines.push(
      `## Conflicts (${result.conflicts.length}) — existing entries are not overwritten. Check them manually`,
    );
    for (const c of result.conflicts) {
      const detail =
        c.reason === "mismatch"
          ? `a symlink pointing elsewhere (currently: ${c.actualTarget ?? "?"})`
          : c.reason === "occupied"
            ? "a real file/directory, not a symlink"
            : "an uninspectable path (a parent component is not a directory, etc.)";
      lines.push(`- ${c.name}: ${detail}`);
    }
    lines.push("");
  }

  if (result.collisions.length > 0) {
    lines.push(
      `## Basename collisions (${result.collisions.length}) — another repo claims the same view name (not auto-wired)`,
    );
    for (const c of result.collisions) lines.push(`- ${c.linkName} ← ${c.repos.join(", ")}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(
      `## Unreachable (${result.unreachable.length}) — path unresolved, or it resolves to the view itself, so it cannot be aggregated`,
    );
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.strayUnknown.length > 0) {
    lines.push(
      `## Strays left in place (${result.strayUnknown.length}) — not confirmed to be a basou-generated repo link, so not pruned. Check them manually`,
    );
    for (const s of result.strayUnknown) {
      const detail =
        s.reason === "broken"
          ? "broken link (target does not resolve)"
          : s.reason === "non-repo"
            ? "non-git-repo target (a file, or a directory without .git)"
            : "absolute-path target (basou generates relative links only)";
      lines.push(`- ${s.name} -> ${s.target}: ${detail}`);
    }
    lines.push("");
  }

  lines.push(
    "Note: creation (--apply) never overwrites an existing entry. Stray repo links are pruned with --prune (only the symlink is removed, never the referenced repo). A stray not confirmed to be basou-generated (broken / non-repo / absolute path) is left in place.",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectPreset}. */
export async function runProjectPreset(
  options: ProjectPresetOptions,
  ctx: ProjectPresetContext = {},
): Promise<void> {
  try {
    await doRunProjectPreset(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** The anchor's canonical file for a repo: `<anchor>/agents/<name>/AGENTS.md`. */
function canonicalFileFor(anchorReal: string, canonicalName: string): string {
  return join(anchorReal, "agents", canonicalName, CANONICAL_FILE);
}

/** The repo-relative label for a canonical (used in marker errors — never an absolute path). */
function canonicalLabelFor(canonicalName: string): string {
  return join("agents", canonicalName, CANONICAL_FILE);
}

/**
 * Gather one declared repo's preset facts. Resolves the repo (realpath); the
 * entry that resolves to the manifest root IS the anchor (its own AGENTS.md is
 * hand-maintained, so it is flagged and skipped). A path that does not resolve
 * or has no `.git` is `reachable: false`. Otherwise it reads the anchor's
 * canonical (`agents/<repo>/AGENTS.md`): absent => to be created; present =>
 * parsed for its marker region so the summarizer can detect drift. A present
 * canonical that cannot be read (a non-ENOENT failure) degrades only this repo
 * (`canonicalReadable: false`) instead of crashing the whole report.
 */
async function gatherRepoPreset(
  repositoryRoot: string,
  anchorReal: string,
  entry: RepoEntry,
): Promise<RepoPresetFacts> {
  const declared = {
    path: entry.path,
    ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
    ...(entry.language !== undefined ? { language: entry.language } : {}),
    ...(entry.publishes !== undefined ? { publishes: entry.publishes } : {}),
  };
  // A `self` repo is hands-off: basou never writes (nor reads) its hand-authored
  // AGENTS.md for preset purposes. Short-circuit before any filesystem probe so
  // it is reported as `self` and skipped, whatever its on-disk state.
  if (instructionMode(entry) === "self") {
    return { ...declared, self: true, isAnchor: false, reachable: true, canonicalPresent: false };
  }
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, entry.path));
  } catch {
    return { ...declared, isAnchor: false, reachable: false, canonicalPresent: false };
  }
  if (real === anchorReal) {
    return { ...declared, isAnchor: true, reachable: true, canonicalPresent: false };
  }
  if (!existsSync(join(real, ".git"))) {
    return { ...declared, isAnchor: false, reachable: false, canonicalPresent: false };
  }

  const canonicalName = basename(real);
  let content: string | null;
  try {
    content = await readMarkdownFile(canonicalFileFor(anchorReal, canonicalName));
  } catch {
    // Present but unreadable (e.g. a directory at that path, or permission denied).
    return {
      ...declared,
      isAnchor: false,
      reachable: true,
      canonicalName,
      canonicalPresent: true,
      canonicalReadable: false,
    };
  }
  if (content === null) {
    return {
      ...declared,
      isAnchor: false,
      reachable: true,
      canonicalName,
      canonicalPresent: false,
    };
  }
  const section = parseMarkers(content);
  return {
    ...declared,
    isAnchor: false,
    reachable: true,
    canonicalName,
    canonicalPresent: true,
    canonicalReadable: true,
    markerKind: section.kind,
    ...(section.kind === "ok" ? { currentBlock: section.generated } : {}),
  };
}

/** Normalize a block for in-sync comparison: LF line endings, no trailing blank lines. */
function normalizeViewBlock(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/**
 * Build the view's declared roster for the preset block: every roster repo's
 * on-disk basename (resolved so an aliased/symlinked path still names the repo
 * the operator sees), with its declared visibility / language and instruction
 * ownership (`instructions: self` renders as self-managed in the block's
 * instruction column). Falls back to the declared path's basename when a repo
 * does not resolve, so the block is stable even while a sibling is transiently
 * uncloned. The anchor is included (it is a roster entry the view aggregates too).
 */
function viewPresetReposFor(repositoryRoot: string, roster: RepoEntry[]): ViewPresetRepo[] {
  // The anchor's own AGENTS.md is hand-maintained (preset skips it), so its row
  // is labeled `anchor`, never `hub`. Resolve the anchor once to compare against.
  let anchorReal: string | undefined;
  try {
    anchorReal = realpathSync(repositoryRoot);
  } catch {
    anchorReal = undefined;
  }
  return roster.map((entry) => {
    const abs = resolve(repositoryRoot, entry.path);
    let real: string | undefined;
    try {
      real = realpathSync(abs);
    } catch {
      real = undefined;
    }
    const name = basename(real ?? abs);
    const isAnchor =
      real !== undefined && anchorReal !== undefined ? real === anchorReal : abs === repositoryRoot;
    return {
      name,
      ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
      ...(entry.language !== undefined ? { language: entry.language } : {}),
      ...(isAnchor ? { anchor: true } : instructionMode(entry) === "self" ? { self: true } : {}),
    };
  });
}

/**
 * Judge the workspace view's OWN canonical (`agents/<viewName>/AGENTS.md`) as a
 * preset target. Unlike {@link gatherRepoPreset} it does NOT require a `.git` — the
 * view is a git-unmanaged directory, not a repo. The caller resolves the view
 * name ONCE (from the resolved view dir) and threads it here and into the
 * roster's summary, so the view↔repo collision suppression judges the same name
 * on both sides; a name shared with a roster repo's canonical is a `collision`
 * (nothing generated for the view). Returns the outcome the caller reports and,
 * for a create/update, the block to write.
 */
function gatherViewPreset(
  repositoryRoot: string,
  anchorReal: string,
  viewName: string,
  roster: RepoEntry[],
): ViewPresetOutcome {
  const collision = viewCanonicalCollision(repositoryRoot, roster, viewName);
  if (collision !== undefined) return { kind: "collision", viewName, repoPath: collision };
  const desiredBlock = renderViewPresetBlock({
    viewName,
    repos: viewPresetReposFor(repositoryRoot, roster),
  });
  const canonicalFile = canonicalFileFor(anchorReal, viewName);

  let content: string | null;
  try {
    content = readFileSync(canonicalFile, "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") {
      return {
        kind: "plan",
        action: "create",
        canonicalName: viewName,
        viewName,
        block: desiredBlock,
      };
    }
    // Present but unreadable (a directory at that path, permission denied, …).
    return { kind: "unreadable", canonicalName: viewName, viewName };
  }
  const section = parseMarkers(content);
  if (section.kind === "ok") {
    if (normalizeViewBlock(section.generated) === normalizeViewBlock(desiredBlock)) {
      return { kind: "in-sync", canonicalName: viewName, viewName };
    }
    return {
      kind: "plan",
      action: "update",
      canonicalName: viewName,
      viewName,
      block: desiredBlock,
    };
  }
  // Present but markers absent/malformed — surface, never clobber.
  return { kind: "conflict", canonicalName: viewName, viewName, reason: section.kind };
}

/**
 * Write the view's canonical (create or update), replacing only the marker region
 * via {@link renderWithMarkers} — the same non-destructive, symlink-refusing,
 * re-read-at-write mechanism {@link applyPresetPlan} uses for a repo canonical.
 */
async function applyViewPreset(
  anchorReal: string,
  outcome: Extract<ViewPresetOutcome, { kind: "plan" }>,
): Promise<void> {
  const file = canonicalFileFor(anchorReal, outcome.canonicalName);
  const label = canonicalLabelFor(outcome.canonicalName);
  let isLink = false;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) throw new Error(`Canonical is a symlink in ${label}`);

  if (outcome.action === "create") mkdirSync(dirname(file), { recursive: true });
  const existing = await readMarkdownFile(file);
  await writeMarkdownFile(file, renderWithMarkers(existing, outcome.block, label));
}

/**
 * Write one planned canonical, always replacing ONLY the marker region via
 * {@link renderWithMarkers} so hand-authored content around it is preserved.
 *
 * Both `create` and `update` re-read the file at write time and render against
 * the CURRENT content (null => fresh). This closes the create-race: if a
 * canonical appeared between gather (which saw it absent) and the write, its
 * hand-authored content around well-formed markers is preserved, and a
 * markerless / malformed file makes {@link renderWithMarkers} throw — collected
 * by the caller as a failure — rather than being clobbered by a blind null-based
 * write. A symlinked canonical is refused: `atomicReplace` would swap the link
 * for a regular file, silently breaking deliberate wiring. The only on-disk
 * mutations are the recursive `mkdir` for a create and the marker-region write.
 */
async function applyPresetPlan(anchorReal: string, plan: RepoPresetPlan): Promise<void> {
  const file = canonicalFileFor(anchorReal, plan.canonicalName);
  const label = canonicalLabelFor(plan.canonicalName);
  // Refuse to replace a symlinked canonical. `lstat` examines the link itself; an
  // absent path (ENOENT) or any uninspectable path is not a symlink to guard —
  // the create branch / the write itself handles those.
  let isLink = false;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) throw new Error(`Canonical is a symlink in ${label}`);

  if (plan.action === "create") mkdirSync(dirname(file), { recursive: true });
  const existing = await readMarkdownFile(file);
  await writeMarkdownFile(file, renderWithMarkers(existing, plan.desiredBlock, label));
}

/**
 * A pathless failure reason for an `--apply` write error. A marker mismatch
 * thrown by {@link renderWithMarkers} (`Markers …`) or the symlink guard above
 * (`Canonical …`) carries an already-safe message (it embeds only the
 * repo-relative label); any other error is reduced to its errno code (from the
 * wrapped cause when present), never the raw message (which would leak an
 * absolute filesystem path into the report / `--json`).
 */
function presetFailureReason(error: unknown): string {
  if (
    error instanceof Error &&
    (error.message.startsWith("Markers") || error.message.startsWith("Canonical"))
  ) {
    return error.message;
  }
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (hasErrorCode(cause)) return cause.code;
  if (hasErrorCode(error)) return error.code;
  return "unknown error";
}

/**
 * Generate each declared repo's canonical instruction-file preset block.
 * Resolves the workspace, reads the manifest, gathers each repo's canonical
 * state, and plans the create/update work. When `--apply` is set and there is
 * something to write, it writes only the marker-delimited region (creating an
 * absent canonical, updating an out-of-date one); a per-repo write failure is
 * collected, not thrown. Without `--apply` it writes nothing and prints the plan.
 */
export async function doRunProjectPreset(
  options: ProjectPresetOptions,
  ctx: ProjectPresetContext,
): Promise<ProjectPresetResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project preset");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const roster = manifest.repos ?? [];
  const anchorReal = realpathSync(repositoryRoot);
  const facts: RepoPresetFacts[] = [];
  for (const entry of roster) facts.push(await gatherRepoPreset(repositoryRoot, anchorReal, entry));

  // The view↔repo canonical-name guard: resolve the view's canonical name once
  // and feed it into the roster summary, so a repo sharing it is suppressed as a
  // collision (the view side is suppressed symmetrically by gatherViewPreset).
  const viewPath = manifest.workspace.view;
  const viewCanonicalName =
    roster.length > 0 && viewPath !== undefined
      ? basename(resolveViewDir(repositoryRoot, viewPath))
      : undefined;
  const summary = summarizePresetPlan(
    facts,
    viewCanonicalName !== undefined ? { viewCanonicalName } : undefined,
  );

  const failures: { repo: string; message: string }[] = [];
  let writtenCount = 0;
  if (options.apply === true && summary.plans.length > 0) {
    for (const plan of summary.plans) {
      try {
        await applyPresetPlan(anchorReal, plan);
        writtenCount += 1;
      } catch (error: unknown) {
        failures.push({ repo: plan.path, message: presetFailureReason(error) });
      }
    }
  }

  // The workspace view's own canonical is a second preset target, judged and
  // (on --apply) generated by the same mechanism but reported separately: it is
  // a git-unmanaged directory, not a roster repo. An empty roster skips the view
  // entirely (`view` stays absent): the run is then a whole no-op, so nothing may
  // be inspected or written for the view either.
  let view: ViewPresetOutcome | undefined;
  let viewApplied = false;
  let viewFailure: string | undefined;
  if (roster.length > 0) {
    view =
      viewCanonicalName === undefined
        ? { kind: "no-view" }
        : gatherViewPreset(repositoryRoot, anchorReal, viewCanonicalName, roster);
    if (options.apply === true && view.kind === "plan") {
      try {
        await applyViewPreset(anchorReal, view);
        viewApplied = true;
      } catch (error: unknown) {
        viewFailure = presetFailureReason(error);
      }
    }
  }

  // The view is a second preset target, so `ok`'s no-false-clear contract must
  // include it: clean = absent (empty roster), no view declared, or `in-sync`.
  // A pending plan, a marker conflict, an unreadable canonical, or a name
  // collision all deny the clean verdict.
  const viewClean = view === undefined || view.kind === "no-view" || view.kind === "in-sync";

  const result: ProjectPresetResult = {
    ...summary,
    ok: summary.ok && viewClean,
    hasRoster: roster.length > 0,
    applied: writtenCount > 0,
    failures,
    ...(view !== undefined ? { view } : {}),
    viewApplied,
    ...(viewFailure !== undefined ? { viewFailure } : {}),
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectPreset(result));
  }
  return result;
}

/** A compact one-line summary of what a plan's generated block declares. */
function presetActionLabel(action: RepoPresetPlan["action"]): string {
  return action === "create" ? "create" : "update";
}

/**
 * Render the preset-generation report. Leads with the actionable outcome: no
 * roster (run adopt first), the per-repo canonical blocks that will be / were
 * written (with the generated block shown in dry-run), then the marker conflicts
 * (canonical present but unmarked/malformed — left untouched, with the remedy),
 * unreadable canonicals, basename collisions, undeclared repos, the skipped
 * anchor, and unreachable repos. A clean "all in sync" verdict is shown only when
 * there is genuinely nothing to do AND every repo was judgeable (no false-clear).
 */
export function renderProjectPreset(result: ProjectPresetResult): string {
  const lines: string[] = [];
  lines.push(
    "# Instruction-file preset generation (declaration → the canonical's generated region)",
  );
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ No repo roster declared (manifest `repos`). Declare one with `basou project adopt`, then re-run.",
    );
    return lines.join("\n");
  }

  if (result.plans.length > 0) {
    // `--apply` was attempted when something was written OR something failed.
    const attempted = result.applied || result.failures.length > 0;
    if (!attempted) {
      lines.push(
        `Preset blocks to generate in the canonical of ${result.plans.length} repo${result.plans.length === 1 ? "" : "s"} (dry-run; pass --apply to write):`,
      );
      for (const p of result.plans) {
        lines.push(
          `- ${p.path} [${presetActionLabel(p.action)}] → ${canonicalLabelFor(p.canonicalName)}`,
        );
        for (const bl of p.desiredBlock.split("\n")) lines.push(`    ${bl}`);
      }
    } else {
      const failed = new Set(result.failures.map((f) => f.repo));
      const header =
        result.failures.length === 0
          ? "✅ Generated preset blocks in the canonical:"
          : result.applied
            ? "Generated preset blocks (some failed, see below):"
            : "Could not generate preset blocks (see below):";
      lines.push(header);
      for (const p of result.plans) {
        if (failed.has(p.path)) continue;
        lines.push(
          `- ${p.path} [${presetActionLabel(p.action)}] → ${canonicalLabelFor(p.canonicalName)}`,
        );
      }
    }
  } else if (result.ok) {
    lines.push(
      "✅ Every declared repo's preset block is in sync with its canonical (nothing to generate).",
    );
  } else {
    lines.push(
      "ℹ️ No repo needs generating, but there are marker conflicts / collisions / undeclared / unreachable repos, or the workspace view canonical needs attention (see below).",
    );
  }
  lines.push("");

  if (result.inSync.length > 0) {
    lines.push(`In sync (${result.inSync.length}): ${result.inSync.join(", ")}`);
    lines.push("");
  }

  if (result.failures.length > 0) {
    lines.push(
      `## Write failed (${result.failures.length}) — some canonicals could not be written`,
    );
    for (const f of result.failures) lines.push(`- ${f.repo}: ${f.message}`);
    lines.push("");
  }

  if (result.markerConflicts.length > 0) {
    lines.push(
      `## Marker conflicts (${result.markerConflicts.length}) — the canonical's markers are missing/malformed, so it is not overwritten`,
    );
    for (const c of result.markerConflicts) {
      const detail =
        c.reason === "no_markers" ? "no marker region" : `malformed markers (${c.reason})`;
      lines.push(`- ${c.repo}: ${detail}`);
    }
    lines.push(
      `  Fix: add these two lines where you want the preset block — \`${GENERATED_START}\` and \`${GENERATED_END}\` (absent, basou creates a fresh canonical).`,
    );
    lines.push("");
  }

  if (result.unreadable.length > 0) {
    lines.push(
      `## Canonical unreadable (${result.unreadable.length}) — could not be read (a directory, permissions, etc.)`,
    );
    for (const p of result.unreadable) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.collisions.length > 0) {
    lines.push(
      `## Canonical collisions (${result.collisions.length}) — another repo (or the workspace view) shares the same-named canonical (not auto-generated)`,
    );
    for (const c of result.collisions) {
      const suffix =
        c.view === true
          ? " + the workspace view (rename the view directory or the repo to disambiguate)"
          : "";
      lines.push(`- agents/${c.canonicalName}/AGENTS.md ← ${c.repos.join(", ")}${suffix}`);
    }
    lines.push("");
  }

  if (result.undeclared.length > 0) {
    lines.push(
      `## Undeclared (${result.undeclared.length}) — visibility / language / publishes unset, so nothing is generated`,
    );
    for (const p of result.undeclared) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.anchors.length > 0) {
    lines.push(
      `## Anchor (${result.anchors.length}) — its own AGENTS.md is hand-maintained, so it is skipped`,
    );
    for (const p of result.anchors) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.self.length > 0) {
    lines.push(
      `## instructions: self (${result.self.length}) — hands-off; their hand-authored AGENTS.md is never written by basou`,
    );
    for (const p of result.self) lines.push(`- ${p}`);
    lines.push("");
  }

  if (result.unreachable.length > 0) {
    lines.push(`## Unreachable (${result.unreachable.length}) — path unresolved / not a git repo`);
    for (const p of result.unreachable) lines.push(`- ${p}`);
    lines.push("");
  }

  appendViewPresetSection(lines, result);

  lines.push(
    "Note: only the marker region is generated; the canonical's hand-authored content (outside the markers) is preserved. The generated content is derived from the manifest declaration.",
  );
  return lines.join("\n");
}

/**
 * Append the workspace-view canonical's own section to the preset report. The
 * view is a second preset target with the same create/update/in-sync/conflict
 * outcomes as a repo canonical, reported separately so it is never conflated with
 * the roster. No `workspace.view` declared prints nothing.
 */
function appendViewPresetSection(lines: string[], result: ProjectPresetResult): void {
  const view = result.view;
  if (view === undefined || view.kind === "no-view") return;
  const canonical = canonicalLabelFor(view.viewName);
  lines.push("## Workspace view canonical (the view's own AGENTS.md)");
  if (view.kind === "collision") {
    lines.push(
      `⚠️ ${view.viewName}: shares its canonical name with the roster repo \`${view.repoPath}\` — both would own ${canonical}, so neither side is generated. Rename the view directory or the repo to disambiguate, then re-run.`,
    );
  } else if (view.kind === "in-sync") {
    lines.push(`✅ ${view.viewName}: in sync with ${canonical} (nothing to generate).`);
  } else if (view.kind === "plan") {
    if (result.viewApplied) {
      lines.push(`✅ ${view.viewName} [${view.action}] → ${canonical}`);
    } else if (result.viewFailure !== undefined) {
      lines.push(`- ${view.viewName} [${view.action}] → ${canonical}: ${result.viewFailure}`);
    } else {
      lines.push(
        `- ${view.viewName} [${view.action}] → ${canonical} (dry-run; pass --apply to write):`,
      );
      for (const bl of view.block.split("\n")) lines.push(`    ${bl}`);
    }
  } else if (view.kind === "conflict") {
    const detail =
      view.reason === "no_markers" ? "no marker region" : `malformed markers (${view.reason})`;
    lines.push(
      `⚠️ ${view.viewName}: ${canonical} has ${detail}, so it is not overwritten. Add \`${GENERATED_START}\` / \`${GENERATED_END}\` where the block should go (or run \`basou project retrofit\` to prepend it, preserving your prose).`,
    );
  } else {
    lines.push(
      `⚠️ ${view.viewName}: ${canonical} could not be read (a directory, permissions, etc.). Resolve it by hand, then re-run.`,
    );
  }
  lines.push("");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectArchive}. */
export async function runProjectArchive(
  target: string,
  options: ProjectArchiveOptions,
  ctx: ProjectArchiveContext = {},
): Promise<void> {
  try {
    await doRunProjectArchive(target, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Inspect the repo-side wiring still present for an archived repo — the manual
 * teardown checklist `--apply` does NOT touch (it only mutates the manifest).
 * Best-effort: an unresolvable repo (already deleted from disk) yields
 * `inspected: false` and empty facts, so archiving a removed repo still works.
 */
function gatherArchiveTeardown(
  repositoryRoot: string,
  manifest: Manifest,
  target: string,
): ArchiveTeardown {
  const empty: ArchiveTeardown = {
    inspected: false,
    viewLink: false,
    instructionFiles: [],
    gitignorePatterns: [],
    canonical: false,
  };
  let real: string;
  try {
    real = realpathSync(resolve(repositoryRoot, target));
  } catch {
    return empty;
  }
  const anchorReal = realpathSync(repositoryRoot);
  const canonicalName = basename(real);

  const instructionFiles: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    try {
      lstatSync(join(real, name));
      instructionFiles.push(name);
    } catch {
      // not present — nothing to tear down
    }
  }

  // An unreadable .gitignore (EACCES / I/O error) must NOT throw out of this
  // advisory, read-only inspection — that would block the authoritative,
  // manifest-only archive write it has no say over. Degrade to "no patterns".
  let ignored: Set<string>;
  try {
    ignored = new Set(readGitignoreLines(join(real, ".gitignore")).map((l) => l.trim()));
  } catch {
    ignored = new Set();
  }
  const gitignorePatterns = INSTRUCTION_FILES.filter((p) => ignored.has(p) || ignored.has(`/${p}`));

  const canonical = existsSync(join(anchorReal, "agents", canonicalName, CANONICAL_FILE));

  let viewLink = false;
  const viewPath = manifest.workspace.view;
  if (viewPath !== undefined) {
    try {
      lstatSync(join(resolveViewDir(repositoryRoot, viewPath), canonicalName));
      viewLink = true;
    } catch {
      // no view entry for this repo
    }
  }

  return {
    inspected: true,
    viewLink,
    instructionFiles,
    gitignorePatterns: [...gitignorePatterns],
    canonical,
  };
}

// --- teardown (the actionable counterpart to archive's read-only checklist) ---

/** The instruction-file symlink targets a repo's wiring would use, computed from
 * the repo + anchor realpaths — independent of whether the canonical FILE still
 * exists, so a dangling hub link to an already-removed canonical is still
 * recognized as ours by its target string. */
function teardownExpectedTargets(repoReal: string, anchorReal: string, canonicalName: string) {
  const canonicalFile = join(anchorReal, "agents", canonicalName, CANONICAL_FILE);
  return expectedSymlinkTargets(repoReal, canonicalFile);
}

/** Does a `<view>/<name>` symlink point (relatively) at exactly `repoReal`? The
 * teardown ownership test for the view link — narrower than the stray-based
 * {@link classifyViewLink} because teardown targets ONE repo, which may still be
 * in the roster (a stray check would exempt it). */
function viewLinkPointsAt(viewDir: string, name: string, repoReal: string): boolean {
  const filePath = join(viewDir, name);
  try {
    if (!lstatSync(filePath).isSymbolicLink()) return false;
    const target = readlinkSync(filePath);
    if (isAbsolute(target)) return false; // basou writes only relative view links
    return realpathSync(resolve(viewDir, target)) === repoReal;
  } catch {
    return false;
  }
}

/** The view-link ownership test when the repo dir is GONE (realpath impossible):
 * the relative link target must resolve, by path, to exactly the repo's declared
 * location. Weaker than {@link viewLinkPointsAt} (no realpath identity), but it is
 * the strongest check available for a dangling orphan link and still refuses an
 * absolute target or a link pointing anywhere else. */
function viewLinkPointsAtPath(viewDir: string, name: string, expectedRepoPath: string): boolean {
  const filePath = join(viewDir, name);
  try {
    if (!lstatSync(filePath).isSymbolicLink()) return false;
    const target = readlinkSync(filePath);
    if (isAbsolute(target)) return false;
    return resolve(viewDir, target) === expectedRepoPath;
  } catch {
    return false;
  }
}

/**
 * Classify a single repo's basou-generated wiring for teardown — read-only.
 * Mirrors the four artifacts the generators create (instruction symlinks,
 * `.gitignore` lines, the view symlink, the canonical's generated block) and
 * marks each `removable` (verified ours), `foreign` (present but not ours — never
 * touched), or `blocked` (uninspectable). Path-driven, NOT roster-driven, so it
 * works after `archive` has already dropped the repo from the manifest. The
 * anchor (`.`) is refused. Absent artifacts are omitted (nothing to report). A
 * repo still declared `instructions: self` keeps its committed instruction files
 * (they are the repo's own tracked content, not basou-generated): they are
 * reported `foreign`, never removed.
 */
function gatherRepoTeardown(
  repositoryRoot: string,
  manifest: Manifest,
  target: string,
): RepoTeardownPlan {
  const anchorReal = realpathSync(repositoryRoot);
  let repoReal: string | undefined;
  try {
    repoReal = realpathSync(resolve(repositoryRoot, target));
  } catch {
    repoReal = undefined;
  }
  const isAnchor = repoReal !== undefined && repoReal === anchorReal;
  const targetAbs = resolve(repositoryRoot, target);
  // `basename` of the resolved path even when realpath failed, so the canonical /
  // view artifacts (which live OUTSIDE the repo dir and survive its deletion) are
  // still found by name.
  const canonicalName = basename(repoReal ?? targetAbs);

  const roster = manifest.repos ?? [];
  const declaredEntry = roster.find((r) => {
    try {
      return realpathSync(resolve(repositoryRoot, r.path)) === (repoReal ?? "\0");
    } catch {
      return resolve(repositoryRoot, r.path) === targetAbs;
    }
  });
  const inRoster = declaredEntry !== undefined;
  // A `self` repo owns its instruction files in its own git history (committed,
  // not basou-generated), so teardown must NOT remove them: each is classified
  // `foreign` (left untouched) instead of `removable`. The view link and any
  // stale anchor canonical are still basou's, so they keep their normal handling.
  const isSelf = declaredEntry !== undefined && instructionMode(declaredEntry) === "self";

  // The canonical (`agents/<basename>/AGENTS.md`) and the view link
  // (`<view>/<basename>`) are keyed by BASENAME and SHARED by any other repo with
  // the same basename. The generators refuse to wire same-basename repos at all;
  // teardown must likewise refuse to remove the SHARED artifacts, or tearing down
  // one repo would strip the block / link another still relies on. Instruction
  // symlinks live inside the repo dir, so they are never shared and stay safe.
  // Case-folded compare: on a case-insensitive filesystem (macOS default) `Pub`
  // and `pub` alias the SAME `agents/<name>` dir / view entry, so they collide
  // even though the byte strings differ.
  const cnFold = canonicalName.toLowerCase();
  const canonicalShared = roster.some((r) => {
    let rReal: string | null = null;
    try {
      rReal = realpathSync(resolve(repositoryRoot, r.path));
    } catch {
      rReal = null;
    }
    if (rReal !== null) {
      if (repoReal !== undefined && rReal === repoReal) return false; // the target itself
      return basename(rReal).toLowerCase() === cnFold;
    }
    if (resolve(repositoryRoot, r.path) === targetAbs) return false;
    return basename(resolve(repositoryRoot, r.path)).toLowerCase() === cnFold;
  });
  const collisionNote =
    "shared with another repo of the same basename, so it cannot be removed (check manually)";

  const items: TeardownItem[] = [];
  if (!isAnchor) {
    // 1. Instruction-file symlinks (live inside the repo dir — never shared).
    if (repoReal !== undefined) {
      for (const spec of teardownExpectedTargets(repoReal, anchorReal, canonicalName)) {
        const { state, actualTarget } = inspectSymlink(join(repoReal, spec.name), spec.target);
        // A `self` repo's instruction files (the committed AGENTS.md and its
        // committed CLAUDE.md / Copilot spokes) are the repo's own tracked
        // content, NOT basou-generated wiring — never remove them. Report any
        // present one as `foreign` (left untouched); a missing one is omitted.
        if (isSelf) {
          if (state !== "missing")
            items.push({
              kind: "instruction-symlink",
              label: spec.name,
              state: "foreign",
              note: "instructions: self — committed, left untouched",
            });
          continue;
        }
        if (state === "correct")
          items.push({ kind: "instruction-symlink", label: spec.name, state: "removable" });
        else if (state === "mismatch")
          items.push({
            kind: "instruction-symlink",
            label: spec.name,
            state: "foreign",
            note: `points at a different target (${actualTarget ?? "?"})`,
          });
        else if (state === "occupied")
          items.push({
            kind: "instruction-symlink",
            label: spec.name,
            state: "foreign",
            note: "a real file, not a symlink",
          });
        else if (state === "blocked")
          items.push({
            kind: "instruction-symlink",
            label: spec.name,
            state: "blocked",
            note: "could not be inspected",
          });
        // "missing" → nothing there → omitted
      }

      // 2. `.gitignore` instruction patterns. The generator appends these WITHOUT
      // a marker, so a present line is INDISTINGUISHABLE from a hand-added one —
      // never provably ours. Reported as a `manual` checklist; `--apply` does not
      // touch `.gitignore` (preferring a false-negative over deleting a line the
      // operator may have added themselves).
      let ignored: Set<string>;
      try {
        ignored = new Set(readGitignoreLines(join(repoReal, ".gitignore")).map((l) => l.trim()));
        for (const p of INSTRUCTION_FILES) {
          if (ignored.has(p) || ignored.has(`/${p}`)) {
            items.push({
              kind: "gitignore",
              label: p,
              state: "manual",
              note: "cannot tell a basou-appended line from a hand-added one (no marker) — remove manually",
            });
          }
        }
      } catch {
        items.push({
          kind: "gitignore",
          label: ".gitignore",
          state: "blocked",
          note: "could not be read",
        });
      }
    }

    // 3. View symlink (in the workspace view dir; survives repo deletion; shared by basename).
    const viewPath = manifest.workspace.view;
    if (viewPath !== undefined) {
      const viewDir = resolveViewDir(repositoryRoot, viewPath);
      const linkPath = join(viewDir, canonicalName);
      let isLink = false;
      try {
        isLink = lstatSync(linkPath).isSymbolicLink();
      } catch {
        isLink = false; // absent → omitted
      }
      if (isLink) {
        const owned =
          repoReal !== undefined
            ? viewLinkPointsAt(viewDir, canonicalName, repoReal)
            : viewLinkPointsAtPath(viewDir, canonicalName, targetAbs);
        if (!owned)
          items.push({
            kind: "view-symlink",
            label: canonicalName,
            state: "foreign",
            note: "a view link that does not point at this repo",
          });
        else if (canonicalShared)
          items.push({
            kind: "view-symlink",
            label: canonicalName,
            state: "blocked",
            note: collisionNote,
          });
        else items.push({ kind: "view-symlink", label: canonicalName, state: "removable" });
      }
    }

    // 4. Canonical's generated block (in the anchor; survives repo deletion; shared by basename).
    const canonicalFile = join(anchorReal, "agents", canonicalName, CANONICAL_FILE);
    const canonicalLabel = join("agents", canonicalName, CANONICAL_FILE);
    let canonicalIsLink = false;
    try {
      canonicalIsLink = lstatSync(canonicalFile).isSymbolicLink();
    } catch {
      canonicalIsLink = false;
    }
    if (canonicalIsLink) {
      items.push({
        kind: "canonical-block",
        label: canonicalLabel,
        state: "foreign",
        note: "the canonical is a symlink (not generated)",
      });
    } else if (existsSync(canonicalFile)) {
      let content: string | undefined;
      try {
        content = readFileSync(canonicalFile, "utf8");
      } catch {
        items.push({
          kind: "canonical-block",
          label: canonicalLabel,
          state: "blocked",
          note: "could not be read",
        });
      }
      if (content !== undefined && content !== "") {
        const section = parseMarkers(content);
        if (section.kind === "ok" && canonicalShared) {
          items.push({
            kind: "canonical-block",
            label: canonicalLabel,
            state: "blocked",
            note: collisionNote,
          });
        } else if (section.kind === "ok" && repoReal === undefined) {
          // Repo dir is gone, so the canonical — keyed only by basename — cannot
          // be proven to have belonged to THIS path (any path with this basename
          // maps here). Report, never auto-remove.
          items.push({
            kind: "canonical-block",
            label: canonicalLabel,
            state: "manual",
            note: "repo could not be resolved, so ownership cannot be verified (check manually)",
          });
        } else if (section.kind === "ok") {
          const emptyAfter = removeMarkerSection(content, canonicalLabel).trim().length === 0;
          items.push({
            kind: "canonical-block",
            label: canonicalLabel,
            state: "removable",
            ...(emptyAfter
              ? {
                  note: "the file becomes empty after the generated block is removed (a manual-delete candidate)",
                }
              : {}),
          });
        } else if (section.kind === "no_markers") {
          items.push({
            kind: "canonical-block",
            label: canonicalLabel,
            state: "foreign",
            note: "no generated block (hand-authored only — left untouched)",
          });
        } else {
          items.push({
            kind: "canonical-block",
            label: canonicalLabel,
            state: "blocked",
            note: "malformed markers (fix manually)",
          });
        }
      }
    }
  }

  return {
    target,
    resolved: repoReal !== undefined,
    repoReal: repoReal ?? null,
    canonicalName,
    isAnchor,
    inRoster,
    items,
    removableCount: items.filter((i) => i.state === "removable").length,
  };
}

/**
 * Remove the `removable` artifacts, RE-VERIFYING each one's ownership predicate
 * immediately before the destructive op (closing the scan-to-apply window, like
 * {@link pruneViewLinks}). A candidate that changed since the scan is skipped with
 * a collected failure rather than removed blindly; every failure is collected,
 * never thrown, so one bad artifact neither aborts the rest nor hides what
 * happened. Only ever removes the link / line / generated block — never a real
 * file, a foreign link, or hand-authored canonical prose.
 */
function applyRepoTeardown(
  repositoryRoot: string,
  manifest: Manifest,
  plan: RepoTeardownPlan,
): { removed: string[]; failed: { label: string; message: string }[] } {
  const removed: string[] = [];
  const failed: { label: string; message: string }[] = [];
  const changed = (label: string) =>
    failed.push({ label, message: "the state changed since the scan (re-run)" });

  // Bind to the SCANNED identity: re-resolve the target now and require it to be
  // the SAME real path classified at scan. If the repo was resolvable at scan but
  // resolves elsewhere (or nowhere) now, a path swap could redirect a destructive
  // write to a different repo's canonical/view — so abort every removal. The
  // canonical/view basename is taken from the plan, never recomputed from a
  // possibly-swapped current target.
  let currentRepoReal: string | null = null;
  try {
    currentRepoReal = realpathSync(resolve(repositoryRoot, plan.target));
  } catch {
    currentRepoReal = null;
  }
  const identityOk = plan.repoReal === null ? true : currentRepoReal === plan.repoReal;
  const removable = plan.items.filter((i) => i.state === "removable");
  if (!identityOk) {
    for (const item of removable) changed(item.label);
    return { removed, failed };
  }

  const anchorReal = realpathSync(repositoryRoot);
  const { canonicalName, repoReal } = plan;

  // 1. Instruction symlinks (only when the repo dir is present), re-verified per link.
  const expectedByName = new Map(
    repoReal !== null
      ? teardownExpectedTargets(repoReal, anchorReal, canonicalName).map((s) => [s.name, s.target])
      : [],
  );
  for (const item of removable.filter((i) => i.kind === "instruction-symlink")) {
    const expected = expectedByName.get(item.label);
    if (
      repoReal === null ||
      expected === undefined ||
      inspectSymlink(join(repoReal, item.label), expected).state !== "correct"
    ) {
      changed(item.label);
      continue;
    }
    try {
      unlinkSync(join(repoReal, item.label));
      removed.push(item.label);
    } catch (error: unknown) {
      failed.push({ label: item.label, message: failureReason(error) });
    }
  }

  // 3. View symlink — re-verify ownership (realpath when present, else path match).
  const viewPath = manifest.workspace.view;
  for (const item of removable.filter((i) => i.kind === "view-symlink")) {
    if (viewPath === undefined) {
      changed(item.label);
      continue;
    }
    const viewDir = resolveViewDir(repositoryRoot, viewPath);
    const owned =
      repoReal !== null
        ? viewLinkPointsAt(viewDir, item.label, repoReal)
        : viewLinkPointsAtPath(viewDir, item.label, resolve(repositoryRoot, plan.target));
    if (!owned) {
      changed(item.label);
      continue;
    }
    try {
      unlinkSync(join(viewDir, item.label));
      removed.push(`view/${item.label}`);
    } catch (error: unknown) {
      failed.push({ label: `view/${item.label}`, message: failureReason(error) });
    }
  }

  // 4. Canonical generated block — the only read-MODIFY-write that FOLLOWS a path,
  // so it is the one place a symlink swapped in after the scan could be followed
  // and an arbitrary target corrupted. Open with `O_NOFOLLOW` so the open itself
  // ATOMICALLY fails (ELOOP) on a symlink — no check-then-use gap — and operate on
  // that single fd (never re-resolving the path). `O_NOFOLLOW` is POSIX; where it
  // is unavailable (Windows) it is 0 and we fall back to the lstat pre-check.
  const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
  for (const item of removable.filter((i) => i.kind === "canonical-block")) {
    const canonicalFile = join(anchorReal, "agents", canonicalName, CANONICAL_FILE);
    try {
      if (lstatSync(canonicalFile).isSymbolicLink()) {
        changed(item.label);
        continue;
      }
    } catch (error: unknown) {
      failed.push({ label: item.label, message: failureReason(error) });
      continue;
    }
    let fd: number;
    try {
      fd = openSync(canonicalFile, fsConstants.O_RDWR | NOFOLLOW);
    } catch (error: unknown) {
      // ELOOP here = a symlink was swapped in after the lstat: refuse, never follow.
      changed(item.label);
      void error;
      continue;
    }
    try {
      const content = readFileSync(fd, "utf8");
      if (parseMarkers(content).kind !== "ok") {
        changed(item.label);
        continue;
      }
      const next = Buffer.from(removeMarkerSection(content, item.label), "utf8");
      ftruncateSync(fd, 0);
      writeSync(fd, next, 0, next.length, 0);
      removed.push(item.label);
    } catch (error: unknown) {
      failed.push({ label: item.label, message: failureReason(error) });
    } finally {
      closeSync(fd);
    }
  }

  // `.gitignore` is intentionally NOT auto-removed (state `manual`): bare appended
  // lines are indistinguishable from hand-added ones, so removal is left to the
  // operator (reported in the plan).

  return { removed, failed };
}

/** Render the teardown plan (dry-run) or outcome (`--apply`) as readable text. */
function renderProjectTeardown(result: ProjectTeardownResult): string {
  const lines: string[] = [];
  lines.push(`# teardown: ${result.target}`);
  lines.push("");
  if (result.isAnchor) {
    lines.push("The anchor (`.`) cannot be torn down (it is the project's home).");
    return lines.join("\n");
  }
  if (!result.resolved) {
    lines.push(
      "Note: the repo path could not be resolved (already deleted?). The in-repo wiring cannot be inspected, so only the view link / canonical are in scope.",
    );
    lines.push("");
  }
  lines.push(
    result.inRoster
      ? "Status: still a roster member (the declaration remains in the manifest)."
      : "Status: not a roster member (already archived).",
  );
  lines.push("");

  const removable = result.items.filter((i) => i.state === "removable");
  const manual = result.items.filter((i) => i.state === "manual");
  const foreign = result.items.filter((i) => i.state === "foreign");
  const blocked = result.items.filter((i) => i.state === "blocked");

  if (removable.length === 0) {
    lines.push("No basou-generated artifact to remove.");
  } else {
    lines.push(`To remove (${removable.length}):`);
    for (const i of removable)
      lines.push(`  - [${i.kind}] ${i.label}${i.note !== undefined ? ` — ${i.note}` : ""}`);
  }
  if (manual.length > 0) {
    lines.push("");
    lines.push("Check manually (not auto-removed):");
    for (const i of manual)
      lines.push(`  - [${i.kind}] ${i.label}${i.note !== undefined ? ` — ${i.note}` : ""}`);
  }
  if (foreign.length > 0) {
    lines.push("");
    lines.push("Left untouched (not basou-generated):");
    for (const i of foreign)
      lines.push(`  - [${i.kind}] ${i.label}${i.note !== undefined ? ` — ${i.note}` : ""}`);
  }
  if (blocked.length > 0) {
    lines.push("");
    lines.push("Could not be inspected:");
    for (const i of blocked)
      lines.push(`  - [${i.kind}] ${i.label}${i.note !== undefined ? ` — ${i.note}` : ""}`);
  }

  lines.push("");
  if (result.applied) {
    lines.push(`--apply: removed ${result.removed.length}.`);
    for (const r of result.removed) lines.push(`  ✓ ${r}`);
    if (result.failed.length > 0) {
      lines.push("Failed:");
      for (const f of result.failed) lines.push(`  ✗ ${f.label} — ${f.message}`);
    }
  } else if (removable.length > 0) {
    lines.push(
      "This is a dry-run. Pass --apply to remove (this is a destructive, irreversible operation).",
    );
  }
  return lines.join("\n");
}

/**
 * Tear down (remove) the basou-generated wiring for one repo: its instruction
 * symlinks, `.gitignore` patterns, view symlink, and the canonical's generated
 * block. Read-only by default (a classified plan); `--apply` removes only the
 * verified-ours artifacts, re-checking each just before it acts. Complements
 * `archive` (which removes the manifest declaration); run that first to fold the
 * repo out, then this to clean its on-disk wiring.
 */
export async function doRunProjectTeardown(
  target: string,
  options: ProjectTeardownOptions,
  ctx: ProjectTeardownContext = {},
): Promise<ProjectTeardownResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project teardown");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  const plan = gatherRepoTeardown(repositoryRoot, manifest, target);

  const willApply = options.apply === true && !plan.isAnchor && plan.removableCount > 0;
  const { removed, failed } = willApply
    ? applyRepoTeardown(repositoryRoot, manifest, plan)
    : { removed: [], failed: [] };

  const result: ProjectTeardownResult = { ...plan, applied: willApply, removed, failed };
  if (options.json === true) console.log(JSON.stringify(result));
  else console.log(renderProjectTeardown(result));
  return result;
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectTeardown}. */
export async function runProjectTeardown(
  target: string,
  options: ProjectTeardownOptions,
  ctx: ProjectTeardownContext = {},
): Promise<void> {
  try {
    await doRunProjectTeardown(target, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/** Shallow clone of an object with one optional key removed (preserves every other own field). */
function omitKey<T extends object>(obj: T, key: keyof T): T {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

/**
 * Build the manifest to write after archiving. Spreads the original so every
 * other manifest field is preserved — both KNOWN fields not handled here and any
 * unknown/future field, which `readManifest`'s loose schema now carries through
 * (at the top level and nested) and surfaces via {@link unknownManifestKeys}. It
 * bumps `updated_at`, removes the target from `repos` (dropping the key entirely when
 * the roster empties, since `repos: []` is not a valid roster), and prunes the
 * target's `source_roots` entry (dropping `source_roots` — and an emptied
 * `import` block — rather than writing an invalid empty list).
 */
function buildArchivedManifest(manifest: Manifest, plan: ArchivePlan, updatedAt: string): Manifest {
  let next: Manifest = { ...manifest, workspace: { ...manifest.workspace, updated_at: updatedAt } };

  next = plan.reposEmptied ? omitKey(next, "repos") : { ...next, repos: plan.nextRepos };

  if (plan.nextSourceRoots !== undefined) {
    if (plan.nextSourceRoots.length === 0) {
      const prunedImport =
        manifest.import !== undefined ? omitKey(manifest.import, "source_roots") : {};
      next =
        Object.keys(prunedImport).length === 0
          ? omitKey(next, "import")
          : { ...next, import: prunedImport };
    } else {
      next = {
        ...next,
        import: { ...(manifest.import ?? {}), source_roots: plan.nextSourceRoots },
      };
    }
  }

  return next;
}

/**
 * Archive (fold) a repo out of the project. Resolves the workspace, reads the
 * manifest, plans the manifest mutation (roster removal + source_roots prune),
 * and inspects the repo-side wiring for the teardown checklist. When `--apply`
 * is set and the target is a real, non-anchor roster member, it writes the
 * pruned manifest (bumping `updated_at`); otherwise it writes nothing and prints
 * the plan. The repo, its captured history, and its on-disk wiring are never
 * touched.
 */
export async function doRunProjectArchive(
  target: string,
  options: ProjectArchiveOptions,
  ctx: ProjectArchiveContext,
): Promise<ProjectArchiveResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project archive");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);
  const roster = manifest.repos ?? [];

  let targetIsAnchor = false;
  try {
    targetIsAnchor = realpathSync(resolve(repositoryRoot, target)) === realpathSync(repositoryRoot);
  } catch {
    targetIsAnchor = false;
  }

  const plan = planArchive({
    ...(manifest.repos !== undefined ? { repos: manifest.repos } : {}),
    ...(manifest.import?.source_roots !== undefined
      ? { sourceRoots: manifest.import.source_roots }
      : {}),
    target,
    targetIsAnchor,
  });

  const teardown =
    plan.found && !plan.isAnchor
      ? gatherArchiveTeardown(repositoryRoot, manifest, target)
      : {
          inspected: false,
          viewLink: false,
          instructionFiles: [],
          gitignorePatterns: [],
          canonical: false,
        };

  const applied = options.apply === true && plan.found && !plan.isAnchor;
  if (applied) {
    const now = ctx.now ?? (() => new Date());
    await writeManifest(paths, buildArchivedManifest(manifest, plan, now().toISOString()), {
      force: true,
    });
  }

  const result: ProjectArchiveResult = {
    ...plan,
    hasRoster: roster.length > 0,
    applied,
    teardown,
    preservedUnknownFields: unknownManifestKeys(manifest),
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectArchive(result));
  }
  return result;
}

/**
 * Render the archive report. Leads with the actionable outcome: no roster (run
 * adopt first), anchor refusal, target not found (with the declared paths), or
 * the manifest mutation that will be / was applied. Then the repo-side teardown
 * checklist (what `--apply` did NOT touch), and a note when the project becomes
 * solo or closes. Dry-run framing makes clear that without `--apply` nothing is
 * written.
 */
export function renderProjectArchive(result: ProjectArchiveResult): string {
  const lines: string[] = [];
  lines.push("# Archive a repo (fold it out of the roster)");
  lines.push("");
  lines.push(...preservedUnknownLines(result.preservedUnknownFields));

  if (!result.hasRoster) {
    lines.push("ℹ️ No repo roster declared (manifest `repos`). There is nothing to archive.");
    return lines.join("\n");
  }

  if (result.isAnchor) {
    lines.push(
      `⚠️ \`${result.target}\` is the anchor (the project root). The anchor cannot be archived (it is the manifest's home).`,
    );
    return lines.join("\n");
  }

  if (!result.found) {
    lines.push(`ℹ️ \`${result.target}\` is not declared in the roster (nothing to archive).`);
    return lines.join("\n");
  }

  // Manifest mutation summary.
  if (result.applied) {
    lines.push(`✅ Removed \`${result.target}\` from the roster.`);
  } else {
    lines.push(`To remove \`${result.target}\` from the roster (dry-run; pass --apply to write):`);
  }
  if (result.sourceRootRemoval !== undefined) {
    lines.push(
      `- ${result.applied ? "Pruned" : "Will prune"} ${result.sourceRootRemoval} from source_roots (no longer captured by refresh).`,
    );
  } else {
    lines.push("- No matching entry in source_roots (nothing to prune).");
  }
  if (result.reposEmptied) {
    lines.push(
      "- This was the last member → the roster empties and the `repos` declaration is removed (the project is folded up).",
    );
  } else if (result.becomesSolo) {
    lines.push(
      "- This leaves 1 repo (solo) → the workspace view is unnecessary (consider removing the view declaration / directory).",
    );
  }
  lines.push("");

  // Teardown checklist (report-only).
  const t = result.teardown;
  const items: string[] = [];
  if (t.viewLink) items.push("the workspace view's symlink entry");
  if (t.instructionFiles.length > 0)
    items.push(`instruction files (${t.instructionFiles.join(", ")})`);
  if (t.gitignorePatterns.length > 0)
    items.push(`.gitignore instruction patterns (${t.gitignorePatterns.join(", ")})`);
  if (t.canonical)
    items.push(`the anchor's canonical (agents/${basename(result.target)}/AGENTS.md)`);

  if (!t.inspected) {
    lines.push(
      "## Manual teardown (the repo could not be resolved on disk, so it was not inspected)",
    );
    lines.push(
      "- The repo may already be deleted. Check manually for a leftover view symlink / instruction symlinks / .gitignore / canonical.",
    );
    lines.push("");
  } else if (items.length > 0) {
    lines.push(
      "## Manual teardown (--apply does not touch these; remove the leftover wiring by hand)",
    );
    for (const i of items) lines.push(`- ${i}`);
    lines.push("");
  } else {
    lines.push("No repo-side wiring (view / instruction files / .gitignore / canonical) remains.");
    lines.push("");
  }

  lines.push(
    "Note: archive only changes the manifest (.basou, git-tracked, reversible). The repo, its captured history, and its on-disk wiring are not removed.",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectRename}. */
export async function runProjectRename(
  oldPath: string,
  newPath: string,
  options: ProjectRenameOptions,
  ctx: ProjectRenameContext = {},
): Promise<void> {
  try {
    await doRunProjectRename(oldPath, newPath, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Inspect the anchor-side wiring still at the OLD basename after a
 * basename-changing rename — the manual checklist `--apply` does NOT touch.
 * Read-only existence checks; an uninspectable path is reported as absent.
 */
function gatherRenameWiring(
  repositoryRoot: string,
  manifest: Manifest,
  oldBasename: string,
): RenameWiring {
  // An uninspectable anchor (a TOCTOU deletion since the manifest was read) must
  // not throw out of this advisory inspection — that would block the
  // authoritative manifest write that runs after it. Degrade to "nothing found".
  let anchorReal: string;
  try {
    anchorReal = realpathSync(repositoryRoot);
  } catch {
    return { canonicalDirOld: false, viewLinkOld: false };
  }
  const canonicalDirOld = existsSync(join(anchorReal, "agents", oldBasename));

  let viewLinkOld = false;
  const viewPath = manifest.workspace.view;
  if (viewPath !== undefined) {
    try {
      lstatSync(join(resolveViewDir(repositoryRoot, viewPath), oldBasename));
      viewLinkOld = true;
    } catch {
      // no view entry at the old basename
    }
  }
  return { canonicalDirOld, viewLinkOld };
}

/**
 * Build the manifest to write after a rename. Spreads the original (preserving
 * every known field), bumps `updated_at`, and replaces `repos` with the
 * re-pathed roster; when the source root was captured, replaces
 * `import.source_roots` with the re-pathed list. A rename never empties either
 * list, so no key is dropped.
 */
function buildRenamedManifest(manifest: Manifest, plan: RenamePlan, updatedAt: string): Manifest {
  const next: Manifest = {
    ...manifest,
    workspace: { ...manifest.workspace, updated_at: updatedAt },
    repos: plan.nextRepos,
  };
  if (plan.nextSourceRoots !== undefined) {
    return { ...next, import: { ...(manifest.import ?? {}), source_roots: plan.nextSourceRoots } };
  }
  return next;
}

/**
 * Re-path a repo in the project. Resolves the workspace, reads the manifest,
 * plans the manifest mutation (roster + source_roots path update), and inspects
 * the anchor-side wiring still at the old basename. When `--apply` is set and the
 * rename is actionable (the source is a real, non-anchor roster member, the
 * destination is free, and old != new), it writes the re-pathed manifest;
 * otherwise it writes nothing and prints the plan. The repo is never moved or
 * rewired on disk.
 */
export async function doRunProjectRename(
  oldPath: string,
  newPath: string,
  options: ProjectRenameOptions,
  ctx: ProjectRenameContext,
): Promise<ProjectRenameResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project rename");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);
  const roster = manifest.repos ?? [];

  let oldIsAnchor = false;
  try {
    oldIsAnchor = realpathSync(resolve(repositoryRoot, oldPath)) === realpathSync(repositoryRoot);
  } catch {
    oldIsAnchor = false;
  }

  const plan = planRename({
    ...(manifest.repos !== undefined ? { repos: manifest.repos } : {}),
    ...(manifest.import?.source_roots !== undefined
      ? { sourceRoots: manifest.import.source_roots }
      : {}),
    oldPath,
    newPath,
    oldIsAnchor,
  });

  const actionable = plan.found && !plan.isAnchor && !plan.collision && !plan.noop;
  const wiring =
    actionable && plan.basenameChanged
      ? gatherRenameWiring(repositoryRoot, manifest, pathBasename(plan.oldTarget))
      : { canonicalDirOld: false, viewLinkOld: false };

  const applied = options.apply === true && actionable;
  if (applied) {
    const now = ctx.now ?? (() => new Date());
    await writeManifest(paths, buildRenamedManifest(manifest, plan, now().toISOString()), {
      force: true,
    });
  }

  const result: ProjectRenameResult = {
    ...plan,
    hasRoster: roster.length > 0,
    applied,
    wiring,
    preservedUnknownFields: unknownManifestKeys(manifest),
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectRename(result));
  }
  return result;
}

/**
 * Render the rename report. Leads with the actionable outcome: no roster, no-op,
 * anchor refusal, collision refusal, source not found, or the manifest mutation
 * that will be / was applied. Then the anchor-side rename checklist (when the
 * basename changed) and a note to re-run the wiring generators.
 */
export function renderProjectRename(result: ProjectRenameResult): string {
  const lines: string[] = [];
  lines.push("# Rename a repo (update its roster path)");
  lines.push("");
  lines.push(...preservedUnknownLines(result.preservedUnknownFields));

  if (!result.hasRoster) {
    lines.push("ℹ️ No repo roster declared (manifest `repos`). There is nothing to rename.");
    return lines.join("\n");
  }
  if (result.noop) {
    lines.push(`ℹ️ \`${result.oldTarget}\` and \`${result.newTarget}\` are identical (no change).`);
    return lines.join("\n");
  }
  if (result.isAnchor) {
    lines.push(
      `⚠️ \`${result.oldTarget}\` is the anchor (the project root). The anchor cannot be renamed.`,
    );
    return lines.join("\n");
  }
  if (!result.found) {
    lines.push(`ℹ️ \`${result.oldTarget}\` is not declared in the roster (nothing to rename).`);
    return lines.join("\n");
  }
  if (result.collision) {
    lines.push(
      `⚠️ \`${result.newTarget}\` is already declared in the roster. Not renaming, to avoid a duplicate.`,
    );
    return lines.join("\n");
  }

  if (result.applied) {
    lines.push(`✅ Renamed \`${result.oldTarget}\` to \`${result.newTarget}\`.`);
  } else {
    lines.push(
      `To rename \`${result.oldTarget}\` to \`${result.newTarget}\` (dry-run; pass --apply to write):`,
    );
  }
  if (result.sourceRootRenamed !== undefined) {
    lines.push(
      `- ${result.applied ? "Updated" : "Will update"} ${result.sourceRootRenamed} to ${result.newTarget} in source_roots.`,
    );
  } else {
    lines.push("- No matching entry in source_roots (nothing to update).");
  }
  lines.push("");

  // Anchor-side checklist (report-only) — only relevant when the basename changes.
  if (result.basenameChanged) {
    const oldName = pathBasename(result.oldTarget);
    const newName = pathBasename(result.newTarget);
    const items: string[] = [];
    if (result.wiring.canonicalDirOld)
      items.push(`anchor canonical: agents/${oldName}/ → agents/${newName}/`);
    if (result.wiring.viewLinkOld) items.push(`workspace view symlink: ${oldName} → ${newName}`);
    if (items.length > 0) {
      lines.push(
        "## Manual rename (--apply does not touch these; the basename changed, so update them by hand)",
      );
      for (const i of items) lines.push(`- ${i}`);
    } else {
      lines.push(
        `The basename changes ${oldName} → ${newName}, but no anchor canonical / view symlink was found.`,
      );
    }
    lines.push(
      "  After applying, regenerate the instruction symlinks and the view with `basou project symlinks` / `basou project workspace`.",
    );
  } else {
    lines.push(
      "Note: the basename is unchanged. If you moved the repo elsewhere, regenerate the relative targets with `basou project symlinks` / `basou project workspace`.",
    );
  }
  lines.push("");

  lines.push(
    "Note: rename only changes the manifest (.basou, git-tracked, reversible). It does not move the repo or update the on-disk wiring.",
  );
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectNew}. */
export async function runProjectNew(
  repos: string[],
  options: ProjectNewOptions,
  ctx: ProjectNewContext = {},
): Promise<void> {
  try {
    await doRunProjectNew(repos, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Wrap the core git capability so the CLI surfaces the command-specific
 * "Run 'git init' first, then re-run 'basou project new'." suffix while the
 * capability layer remains command-agnostic. The anchor must already be a git
 * repository: greenfield scaffolds the project declaration, never the repos.
 * `resolveBasouRootForCommand` is deliberately NOT used — there is no `.basou`
 * yet, so the workspace-resolution fallback would have nothing to resolve.
 */
async function resolveRepositoryRootForNew(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        "Not a git repository. Run 'git init' first, then re-run 'basou project new'.",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Scaffold a new project: resolve the anchor (the current git repository),
 * normalize the given repo paths to repo-root-relative form and require each to
 * be a git repository (basou declares the project, it never creates a repo), then
 * seed a candidate `repos` roster (anchor `.` first, deduped), a `workspace.view`
 * placeholder (unless `--no-view`), and the derived `import.source_roots` (the
 * roster paths plus the view, since work happens with the view as cwd). When
 * `--apply` is set it creates `.basou/`, writes the manifest, and appends the
 * `.gitignore` block (best-effort — scaffolding succeeds even if that step
 * fails). Without `--apply` it writes nothing and prints the plan. Visibility /
 * language are intentionally left unset — the operator fills them in, then runs
 * `basou project derive --apply` to materialize the wiring.
 */
export async function doRunProjectNew(
  repos: string[],
  options: ProjectNewOptions,
  ctx: ProjectNewContext,
): Promise<ProjectNewResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForNew(cwd);
  const workspaceName = basename(repositoryRoot);

  // Normalize each given repo to a repo-root-relative path (the anchor itself
  // becomes "."), then classify it on disk. A path that is not a git repository
  // is collected as invalid — basou scaffolds the declaration, never the repo,
  // so every declared member must already exist. The relative path is computed
  // from realpaths (the repository root git returned IS realpath-resolved), so a
  // symlinked cwd or tmp dir cannot skew it into a long `../../var/...` form; an
  // unresolvable path falls back to the plain relative form for the error label.
  const declared = repos.map((p) => {
    const abs = resolve(cwd, p);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    const rel = relative(repositoryRoot, real);
    return rel === "" ? "." : rel;
  });
  const invalidRepos = declared.filter(
    (rel) => classifySourceRoot(repositoryRoot, rel).kind !== "repo",
  );
  if (invalidRepos.length > 0) {
    throw new Error(
      `These declared repos are not git repositories (create them with 'git init' first): ${invalidRepos.join(", ")}`,
    );
  }

  // The roster always leads with the anchor ("."); a given repo that resolves to
  // the anchor is deduped out (it must not appear twice).
  const rosterPaths = ["."];
  for (const rel of declared) {
    if (rel !== "." && !rosterPaths.includes(rel)) rosterPaths.push(rel);
  }
  const roster: RepoEntry[] = rosterPaths.map((path) => ({ path }));

  // `--no-view` (commander stores it as `view === false`) drops the view; a
  // string overrides the default `<name>-workspace` sibling.
  const viewPath =
    options.view === false ? null : (options.view ?? `../${workspaceName}-workspace`);

  // Work happens with the view as cwd, so the view stays in `source_roots`; the
  // roster excludes it (a view is not a declared repo). Mirrors the existing
  // sync/adopt split between source_roots and repos.
  const sourceRoots = [...rosterPaths, ...(viewPath !== null ? [viewPath] : [])];

  const paths = basouPaths(repositoryRoot);
  const existed = existsSync(paths.files.manifest);

  // Build the manifest from the declaration. `createManifest` knows source_roots
  // but not repos/view, so attach those after.
  const manifest: Manifest = createManifest({ workspaceName, sourceRoots });
  manifest.repos = roster;
  if (viewPath !== null) manifest.workspace.view = viewPath;

  let applied = false;
  if (options.apply === true) {
    await ensureBasouDirectory(repositoryRoot);
    // Refuses (throws "Already initialized. Use --force to overwrite.") when a
    // manifest already exists without --force — the existing contract.
    await writeManifest(paths, manifest, { force: options.force === true });
    applied = true;
    // .gitignore is best-effort: scaffolding succeeds even if this step fails.
    try {
      await appendBasouGitignore(repositoryRoot, { localOnly: options.localOnly === true });
    } catch (error: unknown) {
      renderGitignoreWarningForNew(error, isVerbose(options));
    }
  }

  const result: ProjectNewResult = {
    workspaceName,
    repos: roster,
    view: viewPath,
    sourceRoots,
    invalidRepos: [],
    existed,
    applied,
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectNew(result));
  }
  return result;
}

/**
 * Render a non-fatal warning when `.gitignore` cannot be updated during scaffold.
 * Pathless (it never prints `error.cause.message`, which embeds the absolute
 * path); the cause label is shown only under --verbose.
 */
function renderGitignoreWarningForNew(error: unknown, verbose: boolean): void {
  const baseMessage = error instanceof Error ? error.message : String(error);
  console.error(
    `Warning: Could not update .gitignore (${baseMessage}). Add Basou's default .gitignore block manually.`,
  );
  if (verbose && error instanceof Error) {
    const label = extractCauseLabel(error);
    if (label !== undefined) console.error(`Caused by: ${label}`);
  }
}

/**
 * Render the scaffold report. Leads with the actionable outcome: an existing
 * manifest that `--force` is needed to overwrite, then the seeded roster, view,
 * and source_roots. The dry-run framing makes clear that without `--apply`
 * nothing is written, and the next-step guidance points at declaring visibility /
 * language and running `basou project derive`.
 */
export function renderProjectNew(result: ProjectNewResult): string {
  const lines: string[] = [];
  lines.push("# Scaffold a new project (build from a declaration)");
  lines.push("");

  if (result.existed && !result.applied) {
    lines.push(
      "⚠️ This anchor already has a `.basou/manifest.yaml`. Overwriting it requires --force (nothing is written by default, so an existing declaration is not lost).",
    );
    lines.push("");
  }

  if (result.applied) {
    lines.push(`✅ Created \`.basou/\` for \`${result.workspaceName}\` and seeded the manifest:`);
  } else {
    lines.push(
      `Will create \`.basou/\` for \`${result.workspaceName}\` and seed the manifest (dry-run; pass --apply to write):`,
    );
  }
  lines.push("");

  lines.push(`repos roster (${result.repos.length}):`);
  for (const r of result.repos) {
    lines.push(`- ${r.path}${r.path === "." ? " (anchor)" : ""}`);
  }
  lines.push("");

  lines.push(
    result.view !== null ? `workspace view: ${result.view}` : "workspace view: none (solo project)",
  );
  lines.push("");

  lines.push(`source_roots (${result.sourceRoots.length}):`);
  for (const s of result.sourceRoots) lines.push(`- ${s}`);
  lines.push("");

  lines.push(
    "Note: visibility / language are unset. Assign them to each repo manually. Basou does not create git repos; a declared repo must already be `git init`-ed.",
  );
  if (result.applied) {
    lines.push(
      "Next: fill in visibility / language for each repo in `.basou/manifest.yaml`, then run `basou project derive --apply` to generate the wiring in one pass.",
    );
  } else {
    lines.push(
      "After applying, fill in visibility / language in the manifest, then run `basou project derive`.",
    );
  }
  return lines.join("\n");
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectDerive}. */
export async function runProjectDerive(
  options: ProjectDeriveOptions,
  ctx: ProjectDeriveContext = {},
): Promise<void> {
  try {
    await doRunProjectDerive(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Materialize the full project wiring from the declared manifest by running the
 * fine-grained `project` commands in dependency order. Resolves the workspace,
 * reads the manifest; with no declared roster it prints a no-op hint and returns
 * (not an error — the operator just has nothing to derive yet). Otherwise it runs,
 * in order: sync (`source_roots` ← roster) → preset (canonical blocks) → symlinks
 * (instruction links, after the canonicals they point at exist) → workspace (the
 * view) → gitignore (public repos' `.gitignore`, after the links). Each step reads
 * the manifest itself, so sync's `source_roots` write is visible to the later
 * steps. A throwing step propagates (fail-fast); because every `--apply` step is
 * idempotent, re-running recovers from a partial apply.
 */
export async function doRunProjectDerive(
  options: ProjectDeriveOptions,
  ctx: ProjectDeriveContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project derive");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);

  if (manifest.repos === undefined || manifest.repos.length === 0) {
    console.log(
      "# Generate project wiring in one pass (declaration → wiring)\n\nℹ️ No repo roster declared (manifest `repos`). Declare one first with `basou project new` (new project) or `basou project adopt` (bootstrap from existing source_roots).",
    );
    return;
  }

  const apply = options.apply === true;
  // Shared ctx for every delegated step so the `now` clock (and cwd) stay
  // consistent across the run.
  const stepCtx: ProjectSyncContext = {
    cwd: repositoryRoot,
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  };
  const stepOpts = { apply };

  console.log("# Generate project wiring in one pass (declaration → wiring)");
  console.log("");

  // Each step reads the manifest itself, so sync's source_roots write is visible
  // downstream; order matters (preset before symlinks so link targets exist;
  // symlinks before gitignore so the files to ignore exist).
  console.log("## 1/6 sync source_roots (roster → capture config)");
  await doRunProjectSync(stepOpts, stepCtx);
  console.log("");

  console.log("## 2/6 generate instruction-file A preset (declaration → canonical)");
  await doRunProjectPreset(stepOpts, stepCtx);
  console.log("");

  console.log("## 3/6 seed the anchor's own AGENTS.md (greenfield only; create-only)");
  await doRunProjectSeedAnchor(stepOpts, stepCtx);
  console.log("");

  console.log("## 4/6 generate instruction-file symlinks (each repo → canonical)");
  await doRunProjectSymlinks(stepOpts, stepCtx);
  console.log("");

  console.log("## 5/6 generate workspace view (aggregate the roster repos)");
  await doRunProjectWorkspace(stepOpts, stepCtx);
  console.log("");

  console.log("## 6/6 generate .gitignore (exclude public repos' instruction files)");
  await doRunProjectGitignore(stepOpts, stepCtx);
  console.log("");

  console.log(
    apply
      ? "✅ Ran every step (each is idempotent, so a partial apply recovers on re-run)."
      : "ℹ️ Dry-run preview. Pass --apply to write the changes, then re-run.",
  );
}

/**
 * Derive step: seed the anchor (planning master) repo's OWN root AGENTS.md when
 * it is absent. The anchor's AGENTS.md is hand-maintained (preset skips it) and
 * lives at the anchor ROOT — never under `agents/` — so a greenfield project has
 * none until someone writes one, while a project onboarded the older way already
 * carries one. This create-only seed gives the master a minimal starter
 * (identity, a manifest-derived roster snapshot, per-repo pointers, TODO policy
 * stubs) so greenfield bring-up reaches the same shape; the operator
 * hand-maintains it from there (basou never rewrites it).
 *
 * Create-only and atomic: the write uses the exclusive `wx` flag, so an existing
 * anchor doc (hand-authored, or a prior seed) is never clobbered — with no TOCTOU
 * window between the presence check and the write. A dangling symlink at the path
 * counts as present (never clobbered). An empty roster seeds nothing (there is no
 * project to describe yet).
 */
export async function doRunProjectSeedAnchor(
  options: { apply?: boolean },
  ctx: ProjectSyncContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project derive");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);
  const roster = manifest.repos ?? [];

  console.log("# Anchor instruction-file seed (the planning master's own AGENTS.md)");
  console.log("");

  if (roster.length === 0) {
    console.log("ℹ️ No repo roster declared — nothing to seed.");
    return;
  }

  const anchorDoc = join(repositoryRoot, CANONICAL_FILE);
  // lstat via pathPresent: a dangling symlink counts as present, so a hand-wired
  // link (or any occupant) is never clobbered either.
  if (pathPresent(anchorDoc)) {
    console.log(
      `✅ The anchor's own \`${CANONICAL_FILE}\` already exists — hand-maintained, left untouched.`,
    );
    return;
  }

  const viewPath = manifest.workspace.view;
  const viewName =
    viewPath !== undefined ? basename(resolveViewDir(repositoryRoot, viewPath)) : undefined;
  const repos: AnchorStarterRepo[] = viewPresetReposFor(repositoryRoot, roster);
  const content = renderAnchorStarter({
    anchorName: basename(repositoryRoot),
    ...(manifest.project?.name !== undefined ? { projectName: manifest.project.name } : {}),
    ...(viewName !== undefined ? { viewName } : {}),
    repos,
  });

  if (options.apply !== true) {
    console.log(
      `- ${CANONICAL_FILE} [create] → the anchor's own AGENTS.md (dry-run; pass --apply to write). A create-only starter; hand-maintain it afterward — basou never rewrites it.`,
    );
    return;
  }

  try {
    writeFileSync(anchorDoc, content, { flag: "wx" });
    console.log(
      `✅ Seeded the anchor's own \`${CANONICAL_FILE}\` (create-only starter — hand-maintain it from here; basou never rewrites it).`,
    );
  } catch (error: unknown) {
    // Raced with another writer between the presence check and the exclusive create.
    if (hasErrorCode(error) && error.code === "EEXIST") {
      console.log(
        `✅ The anchor's own \`${CANONICAL_FILE}\` already exists — hand-maintained, left untouched.`,
      );
      return;
    }
    console.log(
      `⚠️ Could not seed the anchor's \`${CANONICAL_FILE}\`: ${presetFailureReason(error)}`,
    );
  }
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunProjectRetrofit}. */
export async function runProjectRetrofit(
  repo: string | undefined,
  options: ProjectRetrofitOptions,
  ctx: ProjectRetrofitContext = {},
): Promise<void> {
  try {
    await doRunProjectRetrofit(repo, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Inspect the repo's own `AGENTS.md` with `lstat` (never following the link).
 * `regular-file` is the only relocatable state; a `symlink` is already wired,
 * `absent` (ENOENT) has nothing to move, and anything else — a non-ENOENT lstat
 * error, or a path that is neither a regular file nor a symlink (a directory) —
 * is `blocked`, so it is never mistaken for relocatable and fed to `--apply`.
 */
function inspectAgentsState(filePath: string): RetrofitFacts["agentsState"] {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(filePath);
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") return "absent";
    return "blocked";
  }
  if (st.isSymbolicLink()) return "symlink";
  return st.isFile() ? "regular-file" : "blocked";
}

/**
 * The repo's spoke instruction files (`CLAUDE.md`, Copilot) that are REGULAR
 * files — they would block clean wiring (`project symlinks` skips an occupied
 * path), so they are surfaced as a manual checklist. A symlink or an absent path
 * is fine and not reported; an uninspectable path is treated as "not a blocker"
 * (the symlink generator will surface it later).
 */
function regularFileSpokes(repoReal: string): string[] {
  const out: string[] = [];
  for (const spoke of ["CLAUDE.md", ".github/copilot-instructions.md"]) {
    try {
      const st = lstatSync(join(repoReal, spoke));
      if (!st.isSymbolicLink() && st.isFile()) out.push(spoke);
    } catch {
      // absent / uninspectable — not a regular-file blocker.
    }
  }
  return out;
}

/**
 * Whether ANY entry exists at the path, as seen by `lstat` — a regular file, a
 * directory, or a symlink (even a dangling one). Distinct from `existsSync`,
 * which follows the link and reports a dangling symlink as absent; the canonical
 * "would be clobbered" check must treat a dangling symlink as present.
 */
function pathPresent(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gather the retrofit facts for one repo. The caller resolves the arg ONCE
 * (`argAbs` = the plain resolved path, `argReal` = its realpath or undefined) and
 * threads the result here AND into the apply step, so classification and the move
 * act on the same resolved repo (no second realpath that could resolve elsewhere
 * after a concurrent change). A roster entry that resolves to the same path (or,
 * when neither resolves, the same plain absolute path) is `declared`. The anchor
 * is the entry resolving to the manifest root; reachability is a `.git` under the
 * resolved path. The repo's own AGENTS.md state, whether the destination canonical
 * already exists (lstat — a dangling symlink counts), and any regular-file spokes
 * are read off disk. `viewCanonicalName` (the workspace view's resolved name, or
 * undefined without a view) is threaded through so the classifier can refuse a
 * relocate into a canonical the view shares. Pure filesystem reads — no writes.
 */
function gatherRetrofit(
  repositoryRoot: string,
  anchorReal: string,
  roster: RepoEntry[],
  argPath: string,
  argAbs: string,
  argReal: string | undefined,
  viewCanonicalName: string | undefined,
): RetrofitFacts {
  const declaredEntry = roster.find((entry) => {
    const entryAbs = resolve(repositoryRoot, entry.path);
    if (argReal !== undefined) {
      try {
        if (realpathSync(entryAbs) === argReal) return true;
      } catch {
        // entry path no longer resolves; fall through to the plain-path compare.
      }
    }
    return entryAbs === argAbs;
  });
  const declared = declaredEntry !== undefined;
  // A declared `self` repo keeps its AGENTS.md in place — retrofit refuses it.
  const self = declaredEntry !== undefined && instructionMode(declaredEntry) === "self";

  // Display the path anchor-relative. Use realpaths on both sides when the arg
  // resolves (so a symlinked tmp/cwd cannot skew it into a "../../private/var/…"
  // form); fall back to the plain resolved path only when it does not resolve.
  const displayRel =
    argReal !== undefined ? relative(anchorReal, argReal) : relative(repositoryRoot, argAbs);
  const path = displayRel === "" ? "." : displayRel;
  const canonicalName = basename(argReal ?? argAbs);

  if (argReal === undefined) {
    return {
      path,
      declared,
      ...(self ? { self: true } : {}),
      isAnchor: false,
      reachable: false,
      canonicalName,
      ...(viewCanonicalName !== undefined ? { viewCanonicalName } : {}),
      agentsState: "absent",
      canonicalExists: false,
      regularSpokes: [],
    };
  }

  const isAnchor = argReal === anchorReal;
  const reachable = existsSync(join(argReal, ".git"));
  const canonicalFile = join(anchorReal, "agents", canonicalName, CANONICAL_FILE);
  return {
    path,
    declared,
    ...(self ? { self: true } : {}),
    isAnchor,
    reachable,
    canonicalName,
    ...(viewCanonicalName !== undefined ? { viewCanonicalName } : {}),
    agentsState: inspectAgentsState(join(argReal, CANONICAL_FILE)),
    canonicalExists: pathPresent(canonicalFile),
    regularSpokes: regularFileSpokes(argReal),
  };
}

/**
 * Outcome of {@link relocateAgentsFile}. `partial` is true only when the canonical
 * was already written (the copy succeeded) before a later step failed — so on-disk
 * state changed and the report must NOT claim "nothing changed".
 */
type RelocateResult = { ok: true } | { ok: false; message: string; partial: boolean };

/**
 * Relocate the repo's regular-file `AGENTS.md` to the anchor canonical and leave a
 * symlink in its place. The canonical is created with `copyFileSync(...,
 * COPYFILE_EXCL)`, which fails atomically with EEXIST if ANYTHING already occupies
 * the path (a file, or a symlink — even a dangling one) — so the "never clobber an
 * existing canonical" contract is enforced by the move primitive itself, with no
 * TOCTOU window between a separate check and the write. Copy (not rename) also
 * works across devices, so no EXDEV special-case is needed. Only after the
 * canonical holds the content is the source unlinked and replaced by the symlink;
 * a failure there is reported as `partial` (the canonical exists, the repo's
 * AGENTS.md may be absent — recoverable by `basou project symlinks` / `derive`,
 * which create the now-missing link). Failures are returned as pathless labels,
 * never thrown.
 */
function relocateAgentsFile(repoReal: string, canonicalFile: string): RelocateResult {
  const agentsFile = join(repoReal, CANONICAL_FILE);
  try {
    mkdirSync(dirname(canonicalFile), { recursive: true });
  } catch (error: unknown) {
    return { ok: false, message: failureReason(error), partial: false };
  }
  // Atomic no-clobber create of the canonical. EEXIST is surfaced as the same
  // "canonical-exists" reason the classifier uses, so a destination that appeared
  // after the facts were gathered is refused, not overwritten.
  try {
    copyFileSync(agentsFile, canonicalFile, fsConstants.COPYFILE_EXCL);
  } catch (error: unknown) {
    const message =
      hasErrorCode(error) && error.code === "EEXIST" ? "canonical-exists" : failureReason(error);
    return { ok: false, message, partial: false };
  }
  // The canonical now holds the content; from here a failure leaves a partial state.
  try {
    unlinkSync(agentsFile);
    symlinkSync(relative(repoReal, canonicalFile), agentsFile);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, message: failureReason(error), partial: true };
  }
}

/**
 * Judge the workspace view's OWN canonical for auto-migration. The greenfield flow
 * BORNS the view canonical with markers (`preset` creates it clean), but an
 * existing view carries a hand-written `agents/<viewName>/AGENTS.md` with prose and
 * NO markers — the exact class `project preset` refuses (it surfaces it as a
 * conflict rather than clobber). Retrofit seeds markers into it: prepend the
 * generated block, keep the prose verbatim (`seedMarkers`). A view name shared
 * with a roster repo's canonical is a `collision` (the shared canonical must
 * never be seeded — it may hold the repo's relocated prose). An absent canonical
 * is left to `preset`/`derive` (retrofit never creates it); a well-formed one
 * needs no migration; a malformed one is surfaced, never rewritten. Pure reads
 * (the write is {@link applyViewRetrofit}'s job).
 */
function gatherViewRetrofit(
  repositoryRoot: string,
  anchorReal: string,
  viewPath: string | undefined,
  roster: RepoEntry[],
): ViewRetrofitOutcome {
  if (viewPath === undefined) return { kind: "no-view" };
  const viewDir = resolveViewDir(repositoryRoot, viewPath);
  const viewName = basename(viewDir);
  const collision = viewCanonicalCollision(repositoryRoot, roster, viewName);
  if (collision !== undefined) return { kind: "collision", viewName, repoPath: collision };
  const canonicalFile = canonicalFileFor(anchorReal, viewName);

  let content: string | null;
  try {
    content = readFileSync(canonicalFile, "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") return { kind: "absent", viewName };
    return { kind: "unreadable", viewName };
  }
  const section = parseMarkers(content);
  if (section.kind === "ok") return { kind: "already-marked", viewName };
  if (section.kind === "no_markers") {
    const block = renderViewPresetBlock({
      viewName,
      repos: viewPresetReposFor(repositoryRoot, roster),
    });
    return { kind: "seed", viewName, block };
  }
  return { kind: "malformed", viewName, reason: section.kind };
}

/**
 * Prepend the generated block into the view's markerless canonical via
 * {@link seedMarkers} (the hand-written prose is preserved verbatim after the
 * block). A symlinked canonical is refused (mirroring {@link applyPresetPlan}). The
 * seed is re-derived against the CURRENT file content at write time, so a canonical
 * that gained markers between gather and write is reconciled (region-replaced), and
 * a malformed one throws — collected by the caller, never clobbered.
 */
async function applyViewRetrofit(
  anchorReal: string,
  outcome: Extract<ViewRetrofitOutcome, { kind: "seed" }>,
): Promise<void> {
  const file = canonicalFileFor(anchorReal, outcome.viewName);
  const label = canonicalLabelFor(outcome.viewName);
  let isLink = false;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) throw new Error(`Canonical is a symlink in ${label}`);
  const existing = await readMarkdownFile(file);
  await writeMarkdownFile(file, seedMarkers(existing, outcome.block, label));
}

/**
 * Retrofit an existing repo's hand-authored `AGENTS.md` into the project
 * topology. Resolves the workspace, reads the manifest, gathers the repo's facts,
 * and classifies the one action. When `--apply` is set and the action is
 * `relocate`, it moves the file to the anchor canonical and recreates the symlink
 * (non-destructive — a present canonical, an already-wired symlink, an absent
 * file, the anchor, a canonical name shared with the workspace view, or an
 * unreachable/undeclared repo all change nothing). The workspace view's OWN
 * markerless canonical (the one class `project preset` refuses to touch) is
 * REPORTED in the same pass, but only the bare form — no repo argument — actually
 * seeds it (prepending the generated block via `seedMarkers`, preserving the
 * prose), so one invocation writes at most one target. An empty roster skips the
 * view entirely: the run is then a whole no-op.
 */
export async function doRunProjectRetrofit(
  repo: string | undefined,
  options: ProjectRetrofitOptions,
  ctx: ProjectRetrofitContext,
): Promise<ProjectRetrofitResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "project retrofit");
  const paths = basouPaths(repositoryRoot);
  const manifest = await readManifest(paths);
  const roster = manifest.repos ?? [];
  const anchorReal = realpathSync(repositoryRoot);
  const viewPath = manifest.workspace.view;

  // No repo argument: run only the workspace view's canonical auto-migration
  // (the path `project preset`'s marker-conflict guidance points at).
  if (repo === undefined) {
    let view: ViewRetrofitOutcome | undefined;
    let viewApplied = false;
    let viewFailure: string | undefined;
    if (roster.length > 0) {
      view = gatherViewRetrofit(repositoryRoot, anchorReal, viewPath, roster);
      if (options.apply === true && view.kind === "seed") {
        try {
          await applyViewRetrofit(anchorReal, view);
          viewApplied = true;
        } catch (error: unknown) {
          viewFailure = presetFailureReason(error);
        }
      }
    }
    const result: ProjectRetrofitResult = {
      kind: "view-only",
      hasRoster: roster.length > 0,
      ...(view !== undefined ? { view } : {}),
      viewApplied,
      ...(viewFailure !== undefined ? { viewFailure } : {}),
    };
    if (options.json === true) {
      console.log(JSON.stringify(result));
    } else {
      console.log(renderProjectRetrofit(result));
    }
    return result;
  }

  // Resolve the arg ONCE and thread it into both classification and the move, so
  // `--apply` acts on exactly the repo that was classified (no second realpath
  // that could resolve elsewhere after a concurrent change, and no uncaught
  // realpath error leaking an absolute path through the generic error path).
  const argAbs = resolve(repositoryRoot, repo);
  let argReal: string | undefined;
  try {
    argReal = realpathSync(argAbs);
  } catch {
    argReal = undefined;
  }

  // The view's resolved canonical name feeds the classifier's view-collision
  // refusal (a repo must never relocate into the canonical the view shares).
  const viewCanonicalName =
    viewPath !== undefined ? basename(resolveViewDir(repositoryRoot, viewPath)) : undefined;
  const facts = gatherRetrofit(
    repositoryRoot,
    anchorReal,
    roster,
    repo,
    argAbs,
    argReal,
    viewCanonicalName,
  );
  const plan = classifyRetrofit(facts);

  let applied = false;
  let failure: string | undefined;
  let partial = false;
  // A `relocate` plan implies the repo was reachable, which implies `argReal` is
  // defined; the guard keeps the type sound without a second realpath.
  if (options.apply === true && plan.action === "relocate" && argReal !== undefined) {
    const canonicalFile = join(anchorReal, "agents", plan.canonicalName, CANONICAL_FILE);
    const res = relocateAgentsFile(argReal, canonicalFile);
    if (res.ok) {
      applied = true;
    } else {
      failure = res.message;
      partial = res.partial;
    }
  }

  // The workspace view's own canonical is REPORTED in the same pass (a markerless
  // prose canonical surfaces as `seed`), but a repo-argument run never writes it:
  // the seed itself is the bare form's job, so `viewApplied` is always false
  // here. An empty roster skips even the report (the run is a whole no-op).
  let view: ViewRetrofitOutcome | undefined;
  if (roster.length > 0) {
    view = gatherViewRetrofit(repositoryRoot, anchorReal, viewPath, roster);
  }

  const result: ProjectRetrofitResult = {
    kind: "repo",
    ...plan,
    hasRoster: roster.length > 0,
    applied,
    ...(failure !== undefined ? { failure } : {}),
    ...(partial ? { partial } : {}),
    ...(view !== undefined ? { view } : {}),
    viewApplied: false,
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderProjectRetrofit(result));
  }
  return result;
}

/**
 * One-line guidance shown with a view seed report: the marker pair placement is
 * the operator's choice, since preset only ever rewrites the region between them.
 */
const MARKER_PORTABILITY_NOTE =
  "The marker pair can later be moved anywhere in the file by hand — `basou project preset` rewrites only the region between the markers.";

/**
 * Append the workspace-view canonical's auto-migration section to the retrofit
 * report. Shown regardless of the repo-arg outcome (the view is a separate target
 * inspected in the same pass — though only the bare form writes it). An absent
 * `view` field (empty roster), no `workspace.view` declared, or a well-formed /
 * absent canonical with nothing to seed, prints nothing.
 */
function appendViewRetrofitSection(lines: string[], result: ProjectRetrofitResult): void {
  const view = result.view;
  if (
    view === undefined ||
    view.kind === "no-view" ||
    view.kind === "absent" ||
    view.kind === "already-marked"
  )
    return;
  const canonical = `agents/${view.viewName}/${CANONICAL_FILE}`;
  lines.push("## Workspace view canonical (auto-migrate the view's own AGENTS.md)");
  if (view.kind === "seed") {
    if (result.kind === "repo") {
      // A repo-argument run only reports the pending seed; the migration itself
      // is the bare form's job (one invocation writes at most one target).
      lines.push(
        `\`${canonical}\` is markerless prose. Run \`basou project retrofit\` (no repo argument) to prepend the generated block, preserving the prose.`,
      );
      lines.push(MARKER_PORTABILITY_NOTE);
    } else if (result.viewApplied) {
      lines.push(
        `✅ Prepended the generated block into \`${canonical}\` (your hand-written prose is preserved below it).`,
      );
      lines.push(MARKER_PORTABILITY_NOTE);
    } else if (result.viewFailure !== undefined) {
      lines.push(`⚠️ Could not seed \`${canonical}\`: ${result.viewFailure}. Nothing was changed.`);
    } else {
      lines.push(
        `\`${canonical}\` is markerless prose. Retrofit will prepend the generated block, preserving the prose (dry-run; pass --apply to write).`,
      );
      lines.push(MARKER_PORTABILITY_NOTE);
    }
  } else if (view.kind === "collision") {
    lines.push(
      `⚠️ The view shares its canonical name with the roster repo \`${view.repoPath}\` — both would own \`${canonical}\`, so nothing is migrated. Rename the view directory or the repo to disambiguate, then re-run.`,
    );
  } else if (view.kind === "malformed") {
    lines.push(
      `⚠️ \`${canonical}\` has malformed markers (${view.reason}), so it is not rewritten. Fix the \`${GENERATED_START}\` / \`${GENERATED_END}\` pair by hand, then re-run.`,
    );
  } else {
    lines.push(
      `⚠️ \`${canonical}\` could not be read (a directory, permissions, etc.). Resolve it by hand, then re-run.`,
    );
  }
  lines.push("");
}

/** Append the regular-file spoke checklist (the manual tidy-up `--apply` leaves alone). */
function appendSpokeChecklist(lines: string[], spokes: string[]): void {
  if (spokes.length === 0) return;
  lines.push(
    `## Spoke files to reconcile (${spokes.length}) — regular files that would block clean wiring`,
  );
  for (const s of spokes) {
    lines.push(
      `- ${s}: a regular file. If it duplicates AGENTS.md, remove it; if it carries unique content, merge it into AGENTS.md. Then run \`basou project symlinks\`.`,
    );
  }
  lines.push("");
}

/**
 * Render the retrofit report. Leads with the actionable outcome: no roster, a
 * refusal (undeclared / anchor / unreachable / uninspectable / a canonical that
 * would be clobbered), an idempotent skip (already a symlink / nothing to move),
 * an apply failure, or the relocation that will be / was performed. Then the
 * spoke checklist and the next step (`basou project derive`).
 */
export function renderProjectRetrofit(result: ProjectRetrofitResult): string {
  const lines: string[] = [];
  lines.push(
    "# Retrofit an existing AGENTS.md into the project (relocate to the anchor canonical)",
  );
  lines.push("");

  if (!result.hasRoster) {
    lines.push(
      "ℹ️ No repo roster declared (manifest `repos`). Declare the repo first with `basou project new` (or `basou project adopt`), then re-run.",
    );
    return lines.join("\n");
  }

  // View-only run (no repo argument): report just the view canonical's migration,
  // with an explicit line for the outcomes appendViewRetrofitSection keeps silent.
  if (result.kind === "view-only") {
    const view = result.view;
    // `view` is gathered whenever the roster is non-empty (the no-roster case
    // returned above), so an absent field is treated like no-view defensively.
    if (view === undefined || view.kind === "no-view") {
      lines.push(
        "ℹ️ No `workspace.view` declared — there is no view canonical to migrate. Pass a repo argument to relocate a repo's AGENTS.md instead.",
      );
    } else if (view.kind === "absent") {
      lines.push(
        `ℹ️ The view canonical \`agents/${view.viewName}/${CANONICAL_FILE}\` does not exist yet — run \`basou project preset --apply\` (or \`basou project derive --apply\`) to create it; there is nothing to migrate.`,
      );
    } else if (view.kind === "already-marked") {
      lines.push(
        `✅ \`agents/${view.viewName}/${CANONICAL_FILE}\` already has a BASOU:GENERATED region. Nothing to migrate.`,
      );
    } else {
      appendViewRetrofitSection(lines, result);
    }
    return lines.join("\n").trimEnd();
  }

  const canonical = `agents/${result.canonicalName}/${CANONICAL_FILE}`;

  if (result.action === "refuse") {
    if (result.reason === "not-declared") {
      lines.push(
        `ℹ️ \`${result.path}\` is not declared in the roster (manifest \`repos\`). Add it first with \`basou project new\` / \`basou project adopt\`, then re-run.`,
      );
    } else if (result.reason === "self") {
      lines.push(
        `ℹ️ \`${result.path}\` declares \`instructions: self\` — its \`${CANONICAL_FILE}\` is a hand-authored committed file that stays in the repo, so there is no anchor canonical to relocate it to. Retrofit does not apply (its CLAUDE.md / Copilot spokes are wired by \`basou project symlinks\`).`,
      );
    } else if (result.reason === "anchor") {
      lines.push(
        `⚠️ \`${result.path}\` is the anchor (the project root). It owns its canonical directly — there is nothing to relocate.`,
      );
    } else if (result.reason === "unreachable") {
      lines.push(
        `⚠️ \`${result.path}\` does not resolve to a git repository. There is nothing to retrofit.`,
      );
    } else if (result.reason === "blocked") {
      lines.push(
        `⚠️ \`${result.path}/${CANONICAL_FILE}\` could not be inspected (a parent component is not a directory, a permission error, or the path is neither a regular file nor a symlink). Resolve it by hand, then re-run.`,
      );
    } else if (result.reason === "view-collision") {
      lines.push(
        `⚠️ \`${result.path}\` shares its canonical name with the workspace view — \`${canonical}\` would be owned by both, so relocating would corrupt one with the other. Rename the view directory or the repo to disambiguate, then re-run.`,
      );
    } else if (result.reason === "canonical-exists") {
      lines.push(
        `⚠️ The destination canonical \`${canonical}\` already exists. Not relocating, to avoid clobbering it. If the canonical is the source of truth, the repo's AGENTS.md is redundant (remove it, then run \`basou project symlinks\`); otherwise reconcile the two by hand.`,
      );
    }
    lines.push("");
    appendViewRetrofitSection(lines, result);
    return lines.join("\n").trimEnd();
  }

  if (result.action === "skip") {
    if (result.reason === "already-symlink") {
      lines.push(
        `✅ \`${result.path}/${CANONICAL_FILE}\` is already a symlink (already wired). Nothing to retrofit.`,
      );
    } else {
      lines.push(
        `ℹ️ \`${result.path}\` has no regular-file \`${CANONICAL_FILE}\` to relocate. If it should have a canonical, run \`basou project derive\` to generate one from the manifest.`,
      );
    }
    lines.push("");
    appendSpokeChecklist(lines, result.regularSpokes);
    appendViewRetrofitSection(lines, result);
    return lines.join("\n").trimEnd();
  }

  // action === "relocate"
  if (result.failure !== undefined) {
    lines.push(
      `Could not relocate \`${result.path}/${CANONICAL_FILE}\` to \`${canonical}\`: ${result.failure}.`,
    );
    if (result.partial === true) {
      // The canonical was already written before a later step failed: do not claim
      // a clean no-op. The repo's AGENTS.md may be absent; derive/symlinks recover.
      lines.push(
        `The canonical \`${canonical}\` was written, but \`${result.path}/${CANONICAL_FILE}\` may be absent. Run \`basou project symlinks --apply\` (or \`basou project derive --apply\`) to recreate the missing link, then verify.`,
      );
    } else {
      lines.push("Nothing was changed. Resolve the cause and re-run.");
    }
    lines.push("");
    appendViewRetrofitSection(lines, result);
    return lines.join("\n").trimEnd();
  }

  if (result.applied) {
    lines.push(
      `✅ Relocated \`${result.path}/${CANONICAL_FILE}\` to \`${canonical}\` and left a symlink in its place.`,
    );
  } else {
    lines.push(
      `To relocate \`${result.path}/${CANONICAL_FILE}\` and replace it with a symlink (dry-run; pass --apply to write):`,
    );
    lines.push(`    move    ${result.path}/${CANONICAL_FILE} -> ${canonical}`);
    lines.push(`    symlink ${result.path}/${CANONICAL_FILE} -> the canonical`);
  }
  lines.push("");
  appendSpokeChecklist(lines, result.regularSpokes);
  appendViewRetrofitSection(lines, result);
  lines.push(
    result.applied
      ? "Next: run `basou project derive --apply` to add the preset block, the CLAUDE.md / Copilot spokes, and the .gitignore."
      : "After applying, run `basou project derive --apply` to finish the wiring (preset block, CLAUDE.md / Copilot spokes, .gitignore).",
  );
  return lines.join("\n");
}
