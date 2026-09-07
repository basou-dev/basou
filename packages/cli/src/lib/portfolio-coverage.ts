import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readManifest } from "@basou/core";
import { resolveSourceRoots } from "../commands/import.js";
import type { WorkspaceEntry } from "./view-server.js";

/**
 * Which native tool wrote a source log. Mirrors the two importers; a log is
 * attributed by its OWN recorded cwd in both, so coverage is adapter-symmetric.
 */
export type CoverageSource = "claude-code" | "codex";

/**
 * Why a source log's cwd matched no registered workspace. The distinction is
 * the whole point of the check, because the two have opposite remedies:
 *
 * - `below_declared_root`: the cwd sits INSIDE a declared source root but is
 *   not equal to it. The owner already declared this repo and the provenance is
 *   still dropped, because both import guards compare the recorded cwd to a
 *   source root verbatim. Nothing the owner can declare fixes this — it is a
 *   report on the exact-match rule itself.
 * - `no_declared_root`: the cwd is under no declared root of any registered
 *   workspace. Usually a real project nobody registered (declare it and the
 *   provenance starts flowing); sometimes a scratch or GUI working directory
 *   with no repo to declare, which is expected to stay unattributed.
 */
export type UnattributedKind = "below_declared_root" | "no_declared_root";

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

export type CoverageResult = {
  /** Source logs seen across both adapter trees. */
  logsScanned: number;
  /** Logs whose cwd equals a source root of some registered workspace. */
  attributed: number;
  /** Unattributed logs, grouped by cwd; `below_declared_root` first, then by size. */
  groups: UnattributedGroup[];
  /** Logs that recorded no cwd at all, so they cannot be placed either way. */
  cwdMissing: number;
  /** Logs that could not be read (permissions, vanished mid-scan). */
  unreadable: number;
  /** Adapter trees that were absent — nothing was scanned for them. */
  absentTrees: string[];
};

/** Injectable seams so tests need no real `~/.claude` / `~/.codex`. */
export type CoverageContext = {
  /** Override the `~/.claude/projects` root (must match the importer's). */
  claudeProjectsDir?: string;
  /** Override the `~/.codex/sessions` root (must match the importer's). */
  codexSessionsDir?: string;
};

/** Total unattributed logs across every group. */
export function unattributedTotal(result: CoverageResult): number {
  return result.groups.reduce((sum, g) => sum + g.logs, 0);
}

/**
 * Report which native session logs on this machine are imported by NO
 * registered workspace — the blind spot behind both import guards.
 *
 * Both importers attribute a source log by its own recorded cwd and require
 * that cwd to EQUAL a declared source root; a log that matches nothing is
 * dropped. Dropping is usually correct (a log belonging to a sibling workspace
 * must not be imported here), and that is exactly why the drop cannot be
 * reported from inside one workspace's import: "this log belongs to no
 * workspace at all" is only answerable across the whole registry. So it is
 * answered here, once, against every registered workspace's roots.
 *
 * Read-only and non-gating: it opens source logs to read their cwd and writes
 * nothing. Unlike the safety preflight it never blocks a portfolio start —
 * uncaptured provenance is a coverage gap, not a write risk.
 */
export async function checkPortfolioCoverage(
  workspaces: ReadonlyArray<WorkspaceEntry>,
  ctx: CoverageContext = {},
): Promise<CoverageResult> {
  const declaredRoots = await collectDeclaredRoots(workspaces);
  const claudeProjectsDir = ctx.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const codexSessionsDir = ctx.codexSessionsDir ?? join(homedir(), ".codex", "sessions");

  const tally = new Tally(declaredRoots);
  const absentTrees: string[] = [];

  const claudeFiles = await listClaudeTranscripts(claudeProjectsDir);
  if (claudeFiles === undefined) absentTrees.push(claudeProjectsDir);
  else for (const file of claudeFiles) await tally.add(file, "claude-code", claudeTranscriptCwd);

  const codexFiles = await listCodexRollouts(codexSessionsDir);
  if (codexFiles === undefined) absentTrees.push(codexSessionsDir);
  else for (const file of codexFiles) await tally.add(file, "codex", codexRolloutCwd);

  return tally.finish(absentTrees);
}

/**
 * Every path some registered workspace would import from, resolved exactly as
 * the importers resolve it: the manifest's `import.source_roots` against the
 * repo root, else the repo root alone. An entry whose manifest is missing or
 * unreadable falls back to its own root — the same fallback
 * {@link resolveSourceRoots} applies — so an uninitialized portfolio entry
 * still claims its own directory rather than claiming nothing.
 */
async function collectDeclaredRoots(
  workspaces: ReadonlyArray<WorkspaceEntry>,
): Promise<Set<string>> {
  const roots = new Set<string>();
  for (const ws of workspaces) {
    let resolved: string[];
    try {
      const manifest = await readManifest(ws.paths);
      resolved = resolveSourceRoots({
        projectFlags: [],
        manifest,
        repoRoot: ws.repoRoot,
        cwd: ws.repoRoot,
      });
    } catch {
      resolved = [ws.repoRoot];
    }
    for (const root of resolved) roots.add(root);
  }
  return roots;
}

/** Accumulates one scan; `finish` orders the groups for reporting. */
class Tally {
  private readonly groups = new Map<string, { logs: number; sources: Set<CoverageSource> }>();
  private attributed = 0;
  private scanned = 0;
  private cwdMissing = 0;
  private unreadable = 0;

  constructor(private readonly declaredRoots: Set<string>) {}

  async add(
    file: string,
    source: CoverageSource,
    readCwd: (file: string) => Promise<string | undefined | null>,
  ): Promise<void> {
    this.scanned++;
    let cwd: string | undefined | null;
    try {
      cwd = await readCwd(file);
    } catch {
      this.unreadable++;
      return;
    }
    // `null` = the file could not be read; `undefined` = read fine, recorded no cwd.
    if (cwd === null) {
      this.unreadable++;
      return;
    }
    if (cwd === undefined) {
      this.cwdMissing++;
      return;
    }
    if (this.declaredRoots.has(cwd)) {
      this.attributed++;
      return;
    }
    const group = this.groups.get(cwd);
    if (group === undefined) this.groups.set(cwd, { logs: 1, sources: new Set([source]) });
    else {
      group.logs++;
      group.sources.add(source);
    }
  }

  finish(absentTrees: string[]): CoverageResult {
    const groups: UnattributedGroup[] = [];
    for (const [cwd, { logs, sources }] of this.groups) {
      const declaredRoot = enclosingRoot(cwd, this.declaredRoots);
      groups.push({
        cwd,
        logs,
        sources: [...sources].sort(),
        kind: declaredRoot === undefined ? "no_declared_root" : "below_declared_root",
        ...(declaredRoot !== undefined ? { declaredRoot } : {}),
      });
    }
    // `below_declared_root` first (declared yet still dropped — the sharper
    // finding), then by size, then by cwd so the report is deterministic.
    groups.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "below_declared_root" ? -1 : 1;
      if (a.logs !== b.logs) return b.logs - a.logs;
      return a.cwd.localeCompare(b.cwd);
    });
    return {
      logsScanned: this.scanned,
      attributed: this.attributed,
      groups,
      cwdMissing: this.cwdMissing,
      unreadable: this.unreadable,
      absentTrees,
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

/**
 * The Claude transcripts the importer would consider: the top-level `*.jsonl`
 * of every per-project directory. Deliberately NOT recursive — the importer's
 * own listing is a flat `readdir`, so nested subagent transcripts are not
 * imported and must not be counted as uncaptured. Returns undefined when the
 * tree itself is absent.
 */
async function listClaudeTranscripts(projectsRoot: string): Promise<string[] | undefined> {
  let dirs: string[];
  try {
    dirs = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return undefined;
  }
  const files: string[] = [];
  for (const dir of dirs) {
    const full = join(projectsRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(full);
    } catch {
      continue; // a project dir vanished or is unreadable; the rest still scan
    }
    for (const name of entries) {
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
 * Read a source log's cwd by streaming it and stopping at the first line that
 * carries one — the same "first record with a cwd" rule both importers use.
 * Streaming matters: these logs run to hundreds of megabytes in aggregate,
 * while the cwd is in the opening records, so a scan costs a few kilobytes per
 * file. No byte cap is imposed, because a cap would make coverage claim "no
 * cwd" for a log the importer reads fine.
 *
 * Returns the cwd, `undefined` when the log carried none, or `null` when the
 * file could not be read.
 */
async function firstCwd(
  file: string,
  pick: (record: Record<string, unknown>) => string | undefined,
): Promise<string | undefined | null> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // a malformed line is skipped, as in the importers
      }
      if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
      const cwd = pick(record as Record<string, unknown>);
      if (cwd !== undefined) return cwd;
    }
    return undefined;
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Claude transcripts carry `cwd` at the top level of a record. */
function claudeTranscriptCwd(file: string): Promise<string | undefined | null> {
  return firstCwd(file, (record) => {
    const cwd = record.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
  });
}

/** Codex rollouts carry `cwd` inside the `session_meta` record's payload. */
function codexRolloutCwd(file: string): Promise<string | undefined | null> {
  return firstCwd(file, (record) => {
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const cwd = (payload as Record<string, unknown>).cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
  });
}

/** How many unattributed cwds to name before collapsing the rest into a count. */
const GROUP_LIST_CAP = 10;

/**
 * Human-readable coverage lines for `basou view --portfolio --check`. Never
 * phrased as a failure: an unattributed scratch or GUI directory is a normal
 * outcome, and the number is only actionable once the owner reads the paths.
 */
export function formatCoverageReport(result: CoverageResult): string[] {
  if (result.logsScanned === 0) {
    const where =
      result.absentTrees.length > 0
        ? ` (no source logs found: ${result.absentTrees.join(", ")})`
        : "";
    return [`Capture coverage: nothing to check — no native session logs on this machine${where}.`];
  }

  const total = unattributedTotal(result);
  const caveats: string[] = [];
  if (result.cwdMissing > 0) caveats.push(`${result.cwdMissing} recorded no cwd`);
  if (result.unreadable > 0) caveats.push(`${result.unreadable} unreadable`);
  if (result.absentTrees.length > 0) caveats.push(`not scanned: ${result.absentTrees.join(", ")}`);
  const caveat = caveats.length > 0 ? ` (${caveats.join("; ")})` : "";

  if (total === 0) {
    return [
      `Capture coverage: OK. ${result.logsScanned} source log(s) scanned, all attributed to a registered workspace${caveat}.`,
    ];
  }

  const pct = Math.round((total / result.logsScanned) * 100);
  const lines = [
    `Capture coverage: ${total} of ${result.logsScanned} source log(s) (${pct}%) are imported by no registered workspace${caveat}:`,
  ];
  for (const g of result.groups.slice(0, GROUP_LIST_CAP)) {
    const via = g.sources.join("+");
    const note =
      g.kind === "below_declared_root"
        ? ` — inside declared root ${g.declaredRoot}, dropped because the recorded cwd must EQUAL a source root`
        : "";
    lines.push(`  ${String(g.logs).padStart(4)}  ${g.cwd} (${via})${note}`);
  }
  const rest = result.groups.length - GROUP_LIST_CAP;
  if (rest > 0) {
    const restLogs = result.groups.slice(GROUP_LIST_CAP).reduce((sum, g) => sum + g.logs, 0);
    lines.push(
      `  … +${rest} more working director${rest === 1 ? "y" : "ies"} (${restLogs} log(s))`,
    );
  }
  if (result.groups.some((g) => g.kind === "below_declared_root")) {
    lines.push(
      "A cwd inside a declared root is provenance you already declared and are still losing; report it rather than working around it.",
    );
  }
  lines.push(
    "Register the project in ~/.basou/portfolio.yaml (or add it to a workspace's import.source_roots) to start capturing it. A scratch directory, a temp path, or a GUI tool's own working directory has no repo to declare and is expected to stay here.",
  );
  return lines;
}
