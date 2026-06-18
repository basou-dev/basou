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
  /** The configured (resolved) path of the monitored repo. Shown to the owner locally so they can fix it. */
  monitoredRepo: string;
  kind: "footprint" | "overlap" | "unverifiable";
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

  for (const ws of workspaces) {
    const wsReal = await canonical(ws.repoRoot);

    let sourceRoots: ReadonlyArray<string> = [];
    try {
      const manifest = await readManifest(ws.paths);
      sourceRoots = manifest.import?.source_roots ?? [];
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

  return { findings, workspacesChecked: workspaces.length, monitoredReposChecked };
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
  const lines = [`Portfolio safety: DANGER — ${result.findings.length} finding(s):`];
  for (const f of result.findings) {
    lines.push(`  [${f.kind}] ${f.monitoredRepo} (workspace "${f.workspaceLabel}"): ${f.detail}`);
  }
  lines.push(
    "A monitored repo must have no basou footprint. Use a separate workspace repo whose source_roots point at the monitored repo as a sibling; never 'basou init' / 'run' / 'exec' inside a monitored repo.",
  );
  return lines;
}
