import { spawn } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { BOARD_DEFAULT_AT } from "./declaration.js";

/**
 * The files a board measure sees in one repository, at the working tree or at
 * a revision, keyed by their path from the repository root (always with '/').
 *
 * At the working tree these are the tracked files and the untracked files git
 * does not ignore (`git ls-files --cached --others --exclude-standard`) that
 * exist on disk; at a revision, the files of that commit's tree. A symlink is
 * followed when it ends at a file inside the repository and is kept as
 * `outside` when it leaves it; one that ends nowhere or at a directory is not
 * a file and is left out, as a submodule is.
 */
export type ScopeEntry = { kind: "file"; source: string } | { kind: "outside" };

export type RepoScope = {
  /** `worktree`, or the revision as the declaration wrote it. */
  at: string;
  entries: ReadonlyMap<string, ScopeEntry>;
  /** The contents of the given file entries, read together. */
  read(paths: readonly string[]): Promise<Map<string, Buffer>>;
};

export type RepoScopeResult = { ok: true; scope: RepoScope } | { ok: false; reason: string };

type GitResult = { code: number | null; stdout: Buffer; stderr: string };

// Run git with an argument list (no shell). GIT_OPTIONAL_LOCKS=0 keeps the
// read-only commands from refreshing and writing the index.
function runGit(cwd: string, args: readonly string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error("Git executable not found in PATH. Install git first.", { cause: error })
          : new Error("Failed to run git", { cause: error }),
      );
    });
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => {
      // git may exit before reading all of stdin; its exit code reports why.
    });
    child.stdin.end(input ?? "");
  });
}

function splitNul(buf: Buffer): string[] {
  return buf
    .toString("utf8")
    .split("\0")
    .filter((s) => s.length > 0);
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Open the scope of the repository at `repoRoot` (an absolute path) for `at`.
 * Not being able to is reported, not thrown: the repository is missing, is
 * not the root of a git repository, or the revision does not exist.
 */
export async function openRepoScope(repoRoot: string, at: string): Promise<RepoScopeResult> {
  try {
    if (!(await stat(repoRoot)).isDirectory()) return { ok: false, reason: "is not a directory" };
  } catch {
    return { ok: false, reason: "is not on disk" };
  }
  const top = await runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ok: false, reason: "is not a git repository" };
  const realRoot = await realpath(repoRoot);
  const topReal = await realpath(top.stdout.toString("utf8").trim()).catch(() => "");
  if (topReal !== realRoot) {
    return { ok: false, reason: "is inside a git repository but is not its root" };
  }
  return at === BOARD_DEFAULT_AT ? openWorktree(realRoot) : openRevision(realRoot, at);
}

async function openWorktree(root: string): Promise<RepoScopeResult> {
  const listed = await runGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (listed.code !== 0) return { ok: false, reason: "could not list its files" };
  const entries = new Map<string, ScopeEntry>();
  const paths = [...new Set(splitNul(listed.stdout))];
  const BATCH = 64;
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const found = await Promise.all(batch.map((p) => worktreeEntry(root, p)));
    batch.forEach((p, j) => {
      const entry = found[j];
      if (entry !== undefined) entries.set(p, entry);
    });
  }
  return {
    ok: true,
    scope: {
      at: BOARD_DEFAULT_AT,
      entries,
      async read(want) {
        const out = new Map<string, Buffer>();
        for (const p of want) {
          const entry = entries.get(p);
          if (entry?.kind === "file") out.set(p, await readFile(entry.source));
        }
        return out;
      },
    },
  };
}

async function worktreeEntry(root: string, path: string): Promise<ScopeEntry | undefined> {
  const abs = join(root, path);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(abs);
  } catch {
    return undefined; // tracked but deleted from the working tree
  }
  if (info.isFile()) return { kind: "file", source: abs };
  if (!info.isSymbolicLink()) return undefined;
  let target: string;
  try {
    target = await realpath(abs);
  } catch {
    return undefined; // ends nowhere
  }
  if (!within(root, target)) return { kind: "outside" };
  try {
    return (await stat(target)).isFile() ? { kind: "file", source: target } : undefined;
  } catch {
    return undefined;
  }
}

type TreeEntry = { mode: string; type: string; oid: string };

async function openRevision(root: string, at: string): Promise<RepoScopeResult> {
  const commit = await runGit(root, ["rev-parse", "--verify", "--quiet", `${at}^{commit}`]);
  if (commit.code !== 0) return { ok: false, reason: `has no revision '${at}'` };
  const oid = commit.stdout.toString("utf8").trim();
  const tree = await runGit(root, ["ls-tree", "-r", "-z", "--full-tree", oid]);
  if (tree.code !== 0) return { ok: false, reason: `could not list its files at '${at}'` };
  const all = new Map<string, TreeEntry>();
  for (const record of splitNul(tree.stdout)) {
    const tab = record.indexOf("\t");
    const [mode, type, blob] = record.slice(0, tab).split(" ");
    if (mode === undefined || type === undefined || blob === undefined) continue;
    all.set(record.slice(tab + 1), { mode, type, oid: blob });
  }
  const links = [...all.values()].filter((e) => e.mode === "120000").map((e) => e.oid);
  const linkTexts = await catFile(root, links);
  const entries = new Map<string, ScopeEntry>();
  for (const [path, entry] of all) {
    if (entry.type !== "blob") continue; // a submodule
    const resolved = entry.mode === "120000" ? resolveLink(path, all, linkTexts) : entry;
    if (resolved === "outside") entries.set(path, { kind: "outside" });
    else if (resolved !== undefined) entries.set(path, { kind: "file", source: resolved.oid });
  }
  return {
    ok: true,
    scope: {
      at,
      entries,
      async read(want) {
        const oids = new Map<string, string>();
        for (const p of want) {
          const entry = entries.get(p);
          if (entry?.kind === "file") oids.set(p, entry.source);
        }
        const blobs = await catFile(root, [...new Set(oids.values())]);
        const out = new Map<string, Buffer>();
        for (const [p, blobOid] of oids) {
          const blob = blobs.get(blobOid);
          if (blob !== undefined) out.set(p, blob);
        }
        return out;
      },
    },
  };
}

// Follow a symlink of the tree to the file it ends at: "outside" when it
// leaves the repository, undefined when it ends nowhere, at a directory, or
// in a loop.
function resolveLink(
  path: string,
  all: ReadonlyMap<string, TreeEntry>,
  linkTexts: ReadonlyMap<string, Buffer>,
): TreeEntry | "outside" | undefined {
  let current = path;
  for (let hop = 0; hop < 40; hop++) {
    const entry = all.get(current);
    if (entry === undefined) return undefined;
    if (entry.mode !== "120000") return entry.type === "blob" ? entry : undefined;
    const text = linkTexts.get(entry.oid)?.toString("utf8");
    if (text === undefined) return undefined;
    if (text.startsWith("/")) return "outside";
    const next = posix.normalize(posix.join(posix.dirname(current), text));
    if (next === ".." || next.startsWith("../")) return "outside";
    current = next;
  }
  return undefined;
}

// Read blobs with one `git cat-file --batch`.
async function catFile(root: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (oids.length === 0) return out;
  const result = await runGit(root, ["cat-file", "--batch"], `${oids.join("\n")}\n`);
  const buf = result.stdout;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.subarray(pos, nl).toString("utf8").split(" ");
    pos = nl + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    out.set(header[0] as string, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return out;
}
