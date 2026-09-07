import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { basouPaths, readManifest, resolveRepositoryRoot } from "@basou/core";
import { encodeProjectDir, readRolloutMeta, resolveSourceRoots } from "../commands/import.js";
import type { WorkspaceEntry } from "./view-server.js";

/**
 * Which native tool wrote a source log. Mirrors the two importers; a log is
 * attributed by its OWN recorded cwd in both, so coverage is adapter-symmetric.
 */
export type CoverageSource = "claude-code" | "codex";

/**
 * Why the importers would not take a source log. The kinds are separated
 * because their remedies differ, and coverage must not describe one as another:
 *
 * - `below_declared_root`: the cwd sits INSIDE a declared source root without
 *   equalling it, so the exact-match rule drops it. The enclosing declaration
 *   does not cover it; declaring the subdirectory itself as a further
 *   `import.source_roots` entry does.
 * - `dir_not_listed`: Claude Code only. The cwd IS a declared root, but the
 *   transcript sits in a per-project directory that no declared root encodes
 *   to, and the importer only ever lists `encodeProjectDir(root)` directories —
 *   so the file is never read despite its cwd matching.
 * - `no_declared_root`: the cwd is under no declared root of any registered
 *   workspace. Usually a project nobody registered; sometimes a scratch or GUI
 *   working directory with no repo to declare, which stays here by design.
 */
export type UnattributedKind = "below_declared_root" | "dir_not_listed" | "no_declared_root";

/** Source logs sharing one recorded cwd that no registered workspace imports. */
export type UnattributedGroup = {
  /** The cwd the source logs recorded, verbatim (never canonicalized). */
  cwd: string;
  /** How many source logs recorded this cwd. */
  logs: number;
  /** Which adapters produced them, in a stable order. */
  sources: CoverageSource[];
  kind: UnattributedKind;
  /** For `below_declared_root`, the declared root the cwd sits inside. */
  declaredRoot?: string;
};

/** Why a registered portfolio entry contributes no declared roots at all. */
export type InertReason = "not_a_git_repo" | "no_store" | "unreadable_store";

/**
 * A registered workspace that cannot import anything, so it claims no roots.
 * Registration alone never causes capture: `basou import` resolves the git
 * toplevel and asserts an initialized `.basou/` before it reads a single log.
 * Counting such an entry's own path as a declared root would let registering a
 * directory move the coverage number without capturing one extra log.
 */
export type InertWorkspace = {
  path: string;
  reason: InertReason;
};

export type CoverageResult = {
  /** Source logs seen across both adapter trees. */
  logsScanned: number;
  /** Logs both guards would take: their cwd equals a declared root AND import lists the file. */
  attributed: number;
  /** Logs import would not take, grouped by recorded cwd. */
  groups: UnattributedGroup[];
  /**
   * Logs import would not take AND coverage cannot place: no usable cwd to name
   * (a Claude transcript that records none, or a rollout whose first record is
   * not a usable `session_meta`). Uncaptured like the groups, just ungroupable.
   */
  unplaceable: number;
  /** Logs that could not be read (permissions, vanished mid-scan) — verdict unknown. */
  unreadable: number;
  /** Adapter trees that were absent — nothing was scanned for them. */
  absentTrees: string[];
  /** Registered entries that import cannot run in, so they declare nothing. */
  inertWorkspaces: InertWorkspace[];
};

/** Injectable seams so tests need no real `~/.claude` / `~/.codex`. */
export type CoverageContext = {
  /** Override the `~/.claude/projects` root (must match the importer's). */
  claudeProjectsDir?: string;
  /** Override the `~/.codex/sessions` root (must match the importer's). */
  codexSessionsDir?: string;
};

/**
 * Logs no registered workspace would import. Includes {@link
 * CoverageResult.unplaceable}: both importers drop a log with no usable cwd, so
 * leaving it out would report those logs as captured.
 */
export function uncapturedTotal(result: CoverageResult): number {
  return result.groups.reduce((sum, g) => sum + g.logs, 0) + result.unplaceable;
}

/**
 * Report which native session logs on this machine are imported by NO
 * registered workspace — the blind spot behind the import guards.
 *
 * Both importers attribute a source log by its own recorded cwd and require
 * that cwd to EQUAL a declared source root; a log that matches nothing is
 * dropped. Dropping is usually correct (a log belonging to a sibling workspace
 * must not be imported here), and that is exactly why the drop cannot be
 * reported from inside one workspace's import: "this log belongs to no
 * workspace at all" is only answerable across the whole registry. So it is
 * answered here, once, against every registered workspace's roots.
 *
 * Every attribution decision runs through the importers' OWN guards, shared
 * rather than re-derived: {@link resolveSourceRoots} for the roots, {@link
 * readRolloutMeta} for a rollout's cwd, {@link encodeProjectDir} for which
 * transcript directories the Claude importer will even list. Coverage claims
 * "import would not take this log", and that claim is only checkable while both
 * sides apply the same rules.
 *
 * Read-only and non-gating: it opens source logs to read their cwd and writes
 * nothing. Unlike the safety preflight it never blocks a portfolio start —
 * uncaptured provenance is a coverage gap, not a write risk.
 */
export async function checkPortfolioCoverage(
  workspaces: ReadonlyArray<WorkspaceEntry>,
  ctx: CoverageContext = {},
): Promise<CoverageResult> {
  const { roots, inertWorkspaces } = await collectDeclaredRoots(workspaces);
  // The per-project directories the Claude importer would list, for any
  // declared root. A transcript outside all of them is never read.
  const listedDirs = new Set([...roots].map((root) => encodeProjectDir(root)));
  const claudeProjectsDir = ctx.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const codexSessionsDir = ctx.codexSessionsDir ?? join(homedir(), ".codex", "sessions");

  const tally = new Tally(roots);
  const absentTrees: string[] = [];

  const claudeFiles = await listClaudeTranscripts(claudeProjectsDir);
  if (claudeFiles === undefined) absentTrees.push(claudeProjectsDir);
  else {
    for (const file of claudeFiles) {
      await tally.add(
        file,
        "claude-code",
        claudeTranscriptCwd,
        listedDirs.has(basename(dirname(file))),
      );
    }
  }

  const codexFiles = await listCodexRollouts(codexSessionsDir);
  if (codexFiles === undefined) absentTrees.push(codexSessionsDir);
  else {
    // The Codex importer walks the whole sessions tree, so every rollout is
    // listed; its only guard is the `session_meta` shape, applied by the reader.
    for (const file of codexFiles) await tally.add(file, "codex", codexRolloutCwd, true);
  }

  return tally.finish(absentTrees, inertWorkspaces);
}

/**
 * Every path some registered workspace would import from, derived the way
 * `basou import` derives it: resolve the git toplevel of the entry, require a
 * readable `.basou/` there, then apply {@link resolveSourceRoots} to that
 * manifest against that toplevel.
 *
 * The toplevel matters. `basou import` starts from `resolveRepositoryRoot(cwd)`,
 * so a portfolio entry registered by a symlinked (or otherwise non-toplevel)
 * spelling imports under the toplevel spelling. Deriving roots from the
 * registered spelling instead would invert coverage for that whole workspace:
 * the symlinked spelling silently matched, the real one reported as missed.
 *
 * An entry import cannot run in claims NO roots and is reported as inert
 * instead, because registration by itself captures nothing.
 */
async function collectDeclaredRoots(
  workspaces: ReadonlyArray<WorkspaceEntry>,
): Promise<{ roots: Set<string>; inertWorkspaces: InertWorkspace[] }> {
  const roots = new Set<string>();
  const inertWorkspaces: InertWorkspace[] = [];
  for (const ws of workspaces) {
    let importRoot: string;
    try {
      importRoot = await resolveRepositoryRoot(ws.repoRoot);
    } catch {
      inertWorkspaces.push({ path: ws.repoRoot, reason: "not_a_git_repo" });
      continue;
    }
    let resolved: string[];
    try {
      const manifest = await readManifest(basouPaths(importRoot));
      resolved = resolveSourceRoots({
        projectFlags: [],
        manifest,
        repoRoot: importRoot,
        cwd: importRoot,
      });
    } catch (error: unknown) {
      const absent = error instanceof Error && error.message === "YAML file not found";
      inertWorkspaces.push({
        path: ws.repoRoot,
        reason: absent ? "no_store" : "unreadable_store",
      });
      continue;
    }
    for (const root of resolved) roots.add(root);
  }
  return { roots, inertWorkspaces };
}

/** Accumulates one scan; `finish` orders the groups for reporting. */
class Tally {
  private readonly groups = new Map<string, { logs: number; sources: Set<CoverageSource> }>();
  private readonly kinds = new Map<string, UnattributedKind>();
  private attributed = 0;
  private scanned = 0;
  private unplaceable = 0;
  private unreadable = 0;

  constructor(private readonly declaredRoots: Set<string>) {}

  /**
   * Record one source log. `listedByImport` is whether the importer would even
   * read this file (the Claude directory guard); a cwd match on a file import
   * never lists is not capture.
   */
  async add(
    file: string,
    source: CoverageSource,
    readCwd: (file: string) => Promise<string | undefined | null>,
    listedByImport: boolean,
  ): Promise<void> {
    this.scanned++;
    // `null` = the file could not be read; `undefined` = read fine, but carries
    // no cwd the importer could use.
    const cwd = await readCwd(file);
    if (cwd === null) {
      this.unreadable++;
      return;
    }
    if (cwd === undefined) {
      this.unplaceable++;
      return;
    }
    const declared = this.declaredRoots.has(cwd);
    if (declared && listedByImport) {
      this.attributed++;
      return;
    }
    const kind: UnattributedKind = declared
      ? "dir_not_listed"
      : enclosingRoot(cwd, this.declaredRoots) !== undefined
        ? "below_declared_root"
        : "no_declared_root";
    this.kinds.set(cwd, kind);
    const group = this.groups.get(cwd);
    if (group === undefined) this.groups.set(cwd, { logs: 1, sources: new Set([source]) });
    else {
      group.logs++;
      group.sources.add(source);
    }
  }

  finish(absentTrees: string[], inertWorkspaces: InertWorkspace[]): CoverageResult {
    const groups: UnattributedGroup[] = [];
    for (const [cwd, { logs, sources }] of this.groups) {
      const kind = this.kinds.get(cwd) ?? "no_declared_root";
      const declaredRoot =
        kind === "below_declared_root" ? enclosingRoot(cwd, this.declaredRoots) : undefined;
      groups.push({
        cwd,
        logs,
        sources: [...sources].sort(),
        kind,
        ...(declaredRoot !== undefined ? { declaredRoot } : {}),
      });
    }
    // The two kinds that name a declared root come first (a declaration is in
    // place and provenance is still dropped), then by size, then by cwd so the
    // report is deterministic.
    const rank = (k: UnattributedKind): number =>
      k === "dir_not_listed" ? 0 : k === "below_declared_root" ? 1 : 2;
    groups.sort((a, b) => {
      if (a.kind !== b.kind) return rank(a.kind) - rank(b.kind);
      if (a.logs !== b.logs) return b.logs - a.logs;
      return a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0;
    });
    return {
      logsScanned: this.scanned,
      attributed: this.attributed,
      groups,
      unplaceable: this.unplaceable,
      unreadable: this.unreadable,
      absentTrees,
      inertWorkspaces,
    };
  }
}

/**
 * The declared root that `cwd` sits strictly inside, or undefined. Compared as
 * path strings with an explicit separator so `/a/bc` is never read as being
 * inside `/a/b`. Purely lexical, matching the guards it reports on.
 */
function enclosingRoot(cwd: string, roots: Set<string>): string | undefined {
  for (const root of roots) {
    if (cwd.startsWith(root.endsWith("/") ? root : `${root}/`)) return root;
  }
  return undefined;
}

/** Whether `entry` is a directory, following a symlink the importer would follow. */
async function isDirEntry(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  // The importer reaches a per-project directory with a plain `readdir(path)`,
  // which follows symlinks. Judging by `isDirectory()` alone would drop a
  // symlinked project directory from the scan entirely — its transcripts would
  // land in no counter at all and the reported denominator would be wrong.
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(join(parent, entry.name))).isDirectory();
  } catch {
    return false; // dangling or unreadable link: nothing to scan
  }
}

/**
 * The Claude transcripts the importer would consider LISTING: the top-level
 * `*.jsonl` of every per-project directory. Deliberately NOT recursive — the
 * importer's own listing is a flat `readdir`, so nested subagent transcripts
 * are not imported and must not be counted as uncaptured. Whether a given
 * directory is actually listed is decided by the caller via
 * {@link encodeProjectDir}. Returns undefined when the tree itself is absent.
 */
async function listClaudeTranscripts(projectsRoot: string): Promise<string[] | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!(await isDirEntry(projectsRoot, entry))) continue;
    const full = join(projectsRoot, entry.name);
    let names: string[];
    try {
      names = await readdir(full);
    } catch {
      continue; // a project dir vanished or is unreadable; the rest still scan
    }
    for (const name of names) {
      if (name.endsWith(".jsonl")) files.push(join(full, name));
    }
  }
  return files.sort();
}

/** Every `rollout-*.jsonl` under the Codex sessions tree (date-nested), or undefined when absent. */
async function listCodexRollouts(sessionsRoot: string): Promise<string[] | undefined> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // a subdir vanished or is unreadable mid-walk; the rest still scan
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        found.push(full);
      }
    }
  };
  try {
    await readdir(sessionsRoot); // an absent root means "no tree", not "an empty tree"
  } catch {
    return undefined;
  }
  await walk(sessionsRoot);
  return found.sort();
}

/**
 * A Claude transcript's cwd: the first record that carries one, which is
 * exactly `firstTranscriptCwd`'s rule in the importer. Streamed and stopped at
 * that record, so a scan costs a few kilobytes of a log that may run to
 * hundreds of megabytes. No byte cap is imposed, because a cap would make
 * coverage claim "no cwd" for a log the importer reads fine.
 *
 * Returns the cwd, `undefined` when the transcript carries none (the importer
 * drops it too), or `null` when the file could not be read.
 */
async function claudeTranscriptCwd(file: string): Promise<string | undefined | null> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // a malformed line is skipped, as in the importer
      }
      if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
      const cwd = (record as Record<string, unknown>).cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    }
    return undefined;
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * A Codex rollout's cwd, read through the importer's own {@link readRolloutMeta}
 * so the guard is identical: the FIRST non-empty record must be a `session_meta`
 * carrying a non-empty `id` and `cwd`. Anything else is a rollout the Codex
 * import never treats as a candidate, and is reported as unplaceable rather
 * than attributed to whatever cwd happens to appear later in the file.
 *
 * `readRolloutMeta` swallows read errors, so an unreadable rollout arrives here
 * as `undefined` rather than `null`; it is counted as uncaptured either way.
 */
async function codexRolloutCwd(file: string): Promise<string | undefined | null> {
  const meta = await readRolloutMeta(file);
  return meta === undefined ? undefined : meta.cwd;
}

/** How many unattributed cwds to name before collapsing the rest into a count. */
const GROUP_LIST_CAP = 10;

/**
 * The trailing clause on a group's line. Only the two kinds that involve a
 * declaration say anything: `no_declared_root` is the plain case and the closing
 * remedy line already covers it.
 */
function groupNote(group: UnattributedGroup): string {
  if (group.kind === "below_declared_root") {
    return ` — inside declared root ${group.declaredRoot}, and the recorded cwd must EQUAL a source root`;
  }
  if (group.kind === "dir_not_listed") {
    return " — this cwd IS a declared root, but the transcript's per-project directory is not one import lists";
  }
  return "";
}

/**
 * Human-readable coverage lines for `basou view --portfolio --check`. Never
 * phrased as a failure: an unattributed scratch or GUI directory is a normal
 * outcome, and the number is only actionable once the owner reads the paths.
 */
export function formatCoverageReport(result: CoverageResult): string[] {
  const lines: string[] = [];
  if (result.logsScanned === 0) {
    const where =
      result.absentTrees.length > 0
        ? ` (no source logs found: ${result.absentTrees.join(", ")})`
        : "";
    lines.push(
      `Capture coverage: nothing to check — no native session logs on this machine${where}.`,
    );
    return [...lines, ...inertLines(result)];
  }

  const total = uncapturedTotal(result);
  const caveats: string[] = [];
  if (result.unreadable > 0) caveats.push(`${result.unreadable} unreadable, verdict unknown`);
  if (result.absentTrees.length > 0) caveats.push(`not scanned: ${result.absentTrees.join(", ")}`);
  const caveat = caveats.length > 0 ? ` (${caveats.join("; ")})` : "";

  // "OK" only when every log scanned is one import would take. Saying it while
  // some log was unreadable, or carried no usable cwd, would report a log as
  // captured on the strength of not having been placed.
  if (total === 0 && result.unreadable === 0) {
    lines.push(
      `Capture coverage: OK. ${result.logsScanned} source log(s) scanned, all imported by a registered workspace${caveat}.`,
    );
    return [...lines, ...inertLines(result)];
  }

  const pct = Math.round((total / result.logsScanned) * 100);
  lines.push(
    `Capture coverage: ${total} of ${result.logsScanned} source log(s) (${pct}%) are imported by no registered workspace${caveat}:`,
  );
  for (const g of result.groups.slice(0, GROUP_LIST_CAP)) {
    const via = g.sources.join("+");
    lines.push(`  ${String(g.logs).padStart(4)}  ${g.cwd} (${via})${groupNote(g)}`);
  }
  const rest = result.groups.length - GROUP_LIST_CAP;
  if (rest > 0) {
    const restLogs = result.groups.slice(GROUP_LIST_CAP).reduce((sum, g) => sum + g.logs, 0);
    lines.push(
      `  … +${rest} more working director${rest === 1 ? "y" : "ies"} (${restLogs} log(s))`,
    );
  }
  if (result.unplaceable > 0) {
    lines.push(
      `  ${String(result.unplaceable).padStart(4)}  (no directory to name: the log records no cwd import can use, so import drops it)`,
    );
  }
  if (result.groups.some((g) => g.kind === "below_declared_root")) {
    lines.push(
      "A cwd inside a declared root is dropped by the exact-match rule: the enclosing declaration does not cover it. Declaring that subdirectory itself as a further import.source_roots entry captures it.",
    );
  }
  if (result.groups.some((g) => g.kind === "dir_not_listed")) {
    lines.push(
      "A transcript whose cwd IS declared but whose per-project directory no declared root encodes to is never listed by the importer. Check that the workspace is registered by the same path spelling the sessions ran in.",
    );
  }
  lines.push(
    "Register the project in a workspace's import.source_roots to start capturing it (registering a path in ~/.basou/portfolio.yaml alone imports nothing — it only adds the workspace to this view). A scratch directory, a temp path, or a GUI tool's own working directory has no repo to declare and is expected to stay here.",
  );
  return [...lines, ...inertLines(result)];
}

/**
 * Registered entries import cannot run in. Reported separately from the log
 * counts because they are a registry fact, not a log: they explain why a path
 * the owner believes is registered captures nothing.
 */
function inertLines(result: CoverageResult): string[] {
  if (result.inertWorkspaces.length === 0) return [];
  const detail: Record<InertReason, string> = {
    not_a_git_repo: "not a git repository",
    no_store: "no .basou store (never initialized)",
    unreadable_store: "the .basou manifest is unreadable",
  };
  const n = result.inertWorkspaces.length;
  const lines = [
    `Capture coverage: ${n} registered entr${n === 1 ? "y" : "ies"} import cannot run in, so ${n === 1 ? "it declares" : "they declare"} no source roots:`,
  ];
  for (const ws of result.inertWorkspaces) {
    lines.push(`  ${ws.path} — ${detail[ws.reason]}`);
  }
  return lines;
}
