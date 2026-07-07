import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { readManifest } from "@basou/core";
import type { WorkspaceEntry } from "./view-server.js";

const execFileAsync = promisify(execFile);

/**
 * A reason a monitored repo (a workspace's `import.source_roots` other than the
 * workspace itself) is — or could become — touched by basou. Portfolio capture
 * is import-based and never writes to a monitored repo, so the only way one gets
 * a `.basou/` is a misconfiguration (a workspace pointed at it, or a stray
 * `basou init` / `run` / `exec` inside it). This preflight makes that mechanical
 * to catch before the irreversible mistake (a committed / pushed footprint).
 *
 * The check is FAIL-CLOSED: anything it cannot verify (an unreadable directory,
 * an unparseable manifest) is reported as `unverifiable` rather than assumed
 * safe.
 */
export type SafetyFinding = {
  workspaceLabel: string;
  workspaceRoot: string;
  /**
   * The configured (resolved) path this finding is about, shown to the owner
   * locally so they can fix it. For `footprint` / `overlap` / `unverifiable`
   * it is the monitored repo; for `redundant` it is the redundant entry itself
   * (the one to remove from the registry).
   */
  monitoredRepo: string;
  /**
   * `footprint` / `overlap` / `unverifiable` are monitored-repo write risks
   * that gate a portfolio start. `redundant` is a registry-hygiene warning: a
   * listed entry resolves to the same planning master as another (its view or a
   * source-root repo), producing a duplicate card. It never gates a start — the
   * read-only view still opens — but `basou view --check` reports it.
   */
  kind: "footprint" | "overlap" | "unverifiable" | "redundant";
  detail: string;
};

export type SafetyResult = {
  findings: SafetyFinding[];
  workspacesChecked: number;
  monitoredReposChecked: number;
};

type ErrnoLike = { code?: string };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & ErrnoLike).code : undefined;
}

/** Canonicalize via realpath so symlinked spellings compare by real identity; fall back to a lexical resolve. */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/** True when `child` is `parent` itself or nested inside it (both expected canonical). */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A tracked path (relative to the repo) that is, or is under, a `.basou/` dir anywhere in the tree. */
function isBasouPath(p: string): boolean {
  return (
    p === ".basou" || p.startsWith(".basou/") || p.includes("/.basou/") || p.endsWith("/.basou")
  );
}

/**
 * Inspect a monitored repo for a basou footprint. Returns a finding kind or null
 * when clean. Detection is two-pronged and FAIL-CLOSED:
 *  - filesystem: a top-level `.basou` entry (the common stray-init / run / exec
 *    location, which lands at the repo root). A non-ENOENT stat error (e.g.
 *    EACCES, ELOOP) is reported as `unverifiable`, never assumed clean.
 *  - git: ANY tracked path under a `.basou/` directory, at the root OR nested
 *    (a submodule / nested repo) — this is the irreversible, pushable case.
 */
async function inspectRepo(
  repoPath: string,
): Promise<{ kind: "footprint" | "unverifiable"; detail: string } | null> {
  let hasEntry = false;
  try {
    await lstat(join(repoPath, ".basou"));
    hasEntry = true;
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      return {
        kind: "unverifiable",
        detail: `could not check for a .basou here (${errorCode(error) ?? "unknown error"}) — treat as unsafe`,
      };
    }
  }

  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "ls-files", "-z"]);
    const tracked = stdout.split("\0").some((f) => f.length > 0 && isBasouPath(f));
    if (tracked) {
      return {
        kind: "footprint",
        detail: "a .basou/ entry is tracked by git here and would be pushed",
      };
    }
  } catch {
    // Not a git repo (or git unavailable): the filesystem check stands alone.
  }

  if (hasEntry) return { kind: "footprint", detail: "a .basou/ entry exists here" };
  return null;
}

/**
 * Verify that no monitored repo (a workspace's source roots, excluding the
 * workspace itself) carries a basou footprint, and that no workspace's `.basou/`
 * would land inside a monitored repo. Read-only: it stats `.basou` and runs
 * `git ls-files` against monitored repos but writes nothing. Returns the
 * findings (empty = safe).
 *
 * Known limitation (documented in the spec): if the owner lists a precious repo
 * DIRECTLY as a workspace, its own root is exempt (a workspace's `.basou/` is
 * by design), so the tool cannot tell "this workspace IS a precious repo" from
 * "this is a dedicated aggregator". Workspaces must be dedicated planning repos.
 */
export async function checkPortfolioSafety(workspaces: WorkspaceEntry[]): Promise<SafetyResult> {
  const findings: SafetyFinding[] = [];
  let monitoredReposChecked = 0;

  // Per-entry data for the redundancy pass, gathered as each manifest is read so
  // no manifest is read twice.
  const records: EntryRecord[] = [];

  for (const ws of workspaces) {
    const wsReal = await canonical(ws.repoRoot);

    let sourceRoots: ReadonlyArray<string> = [];
    let viewPath: string | undefined;
    let isMaster = false;
    try {
      const manifest = await readManifest(ws.paths);
      sourceRoots = manifest.import?.source_roots ?? [];
      viewPath = manifest.workspace.view;
      isMaster = true; // a readable manifest means this entry owns a `.basou/` store
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "YAML file not found") {
        // Truly uninitialized: no source roots, and it only ever writes to its
        // own (separate) root. Genuinely nothing to protect.
        sourceRoots = [];
      } else {
        // Present but unreadable/invalid: we cannot tell what it monitors. Fail closed.
        findings.push({
          workspaceLabel: ws.label,
          workspaceRoot: ws.repoRoot,
          monitoredRepo: ws.repoRoot,
          kind: "unverifiable",
          detail:
            "the workspace manifest is present but unreadable — cannot determine which repos it monitors; treat as unsafe",
        });
        // An unreadable master cannot claim members; record it as its own identity.
        records.push({ ws, real: wsReal, isMaster: false, claimed: new Set() });
        continue;
      }
    }

    // Map canonical monitored path -> the configured (resolved) path for display.
    const monitored = new Map<string, string>();
    for (const root of sourceRoots) {
      const display = resolve(ws.repoRoot, root);
      const real = await canonical(display);
      if (real !== wsReal) monitored.set(real, display); // `.` (the workspace itself) is exempt
    }

    // The canonical paths this master "owns" beyond its own root: its monitored
    // source roots plus its generated workspace view. Reverses the master's
    // declaration the same way {@link resolveMemberToMaster} matches a member's
    // root against a master's `source_roots`, extended to cover the view (which
    // is declared under `workspace.view`, not `source_roots`).
    const claimed = new Set<string>(monitored.keys());
    if (isMaster && viewPath !== undefined) {
      const viewReal = await canonical(resolve(ws.repoRoot, viewPath));
      if (viewReal !== wsReal) claimed.add(viewReal);
    }
    records.push({ ws, real: wsReal, isMaster, claimed });

    for (const [real, display] of monitored) {
      monitoredReposChecked++;
      if (isInside(wsReal, real)) {
        findings.push({
          workspaceLabel: ws.label,
          workspaceRoot: ws.repoRoot,
          monitoredRepo: display,
          kind: "overlap",
          detail: "the workspace (where .basou/ is written) is inside this monitored repo",
        });
      }
      const inspection = await inspectRepo(real);
      if (inspection !== null) {
        findings.push({
          workspaceLabel: ws.label,
          workspaceRoot: ws.repoRoot,
          monitoredRepo: display,
          kind: inspection.kind,
          detail: inspection.detail,
        });
      }
    }
  }

  findings.push(...detectRedundantEntries(records));

  return { findings, workspacesChecked: workspaces.length, monitoredReposChecked };
}

/** One registered portfolio entry, resolved for the redundancy pass. */
type EntryRecord = {
  ws: WorkspaceEntry;
  /** The entry's own canonical (realpath) root. */
  real: string;
  /** True when the entry owns a readable `.basou/` store (it IS a planning master). */
  isMaster: boolean;
  /** Canonical paths this entry (when a master) claims: its source roots and view. */
  claimed: Set<string>;
};

/**
 * Detect portfolio entries that resolve to the same planning master as another
 * listed entry — the duplicate-card footgun: registering both a master (its
 * `.basou`-owning anchor) and its workspace view, or a member/source-root repo,
 * shows the same underlying workspace twice.
 *
 * Each entry resolves to a master identity: a master (readable `.basou/`) is its
 * own identity; a storeless entry inherits the identity of any listed master
 * that claims its root (via a `source_root` or the `workspace.view`), else it is
 * its own identity. Entries grouped under one identity beyond the first are
 * flagged; the master (or, if the master itself is not listed, the first entry)
 * is the primary the others point at.
 */
function detectRedundantEntries(records: EntryRecord[]): SafetyFinding[] {
  const masterIdentity = (r: EntryRecord): string => {
    if (r.isMaster) return r.real;
    const owner = records.find((o) => o.isMaster && o.claimed.has(r.real));
    return owner !== undefined ? owner.real : r.real;
  };

  const groups = new Map<string, EntryRecord[]>();
  for (const r of records) {
    const key = masterIdentity(r);
    const group = groups.get(key);
    if (group !== undefined) group.push(r);
    else groups.set(key, [r]);
  }

  const findings: SafetyFinding[] = [];
  for (const [identity, group] of groups) {
    if (group.length < 2) continue;
    const primary = group.find((r) => r.real === identity) ?? (group[0] as EntryRecord);
    for (const r of group) {
      if (r === primary) continue;
      findings.push({
        workspaceLabel: r.ws.label,
        workspaceRoot: r.ws.repoRoot,
        monitoredRepo: r.ws.repoRoot,
        kind: "redundant",
        detail: `resolves to the same workspace as portfolio entry "${primary.ws.label}" (${primary.ws.repoRoot}) and shows a duplicate card — register only the planning master (the anchor that owns .basou), not its workspace view or a source-root repo; remove this entry from the registry`,
      });
    }
  }
  return findings;
}

/** Human-readable preflight report lines (also used by `--check`). */
export function formatSafetyReport(result: SafetyResult): string[] {
  if (result.findings.length === 0) {
    if (result.monitoredReposChecked === 0) {
      return [
        `Portfolio safety: OK. ${result.workspacesChecked} workspace(s) checked — no monitored repos configured (portfolio safety applies when a workspace imports from sibling repos via source_roots).`,
      ];
    }
    return [
      `Portfolio safety: OK. ${result.workspacesChecked} workspace(s), ${result.monitoredReposChecked} monitored repo(s) checked — no .basou footprint, no overlap.`,
    ];
  }
  const kinds = new Set(result.findings.map((f) => f.kind));
  // A footprint / overlap / unverifiable item is a monitored-repo write risk;
  // a lone redundancy is registry hygiene, not danger.
  const hasWriteRisk = kinds.has("footprint") || kinds.has("overlap") || kinds.has("unverifiable");
  const severity = hasWriteRisk ? "DANGER" : "WARNING";
  const lines = [`Portfolio safety: ${severity} — ${result.findings.length} finding(s):`];
  for (const f of result.findings) {
    lines.push(`  [${f.kind}] ${f.monitoredRepo} (workspace "${f.workspaceLabel}"): ${f.detail}`);
  }
  if (hasWriteRisk) {
    lines.push(
      "A monitored repo must have no basou footprint. Use a separate workspace repo whose source_roots point at the monitored repo as a sibling; never 'basou init' / 'run' / 'exec' inside a monitored repo.",
    );
  }
  if (kinds.has("redundant")) {
    lines.push(
      "A redundant entry is a workspace already reached through another registered planning master. Register only the planning master (the anchor that owns .basou), never its workspace view or its member / source-root repos — those resolve back to the same workspace and produce duplicate cards.",
    );
  }
  return lines;
}
