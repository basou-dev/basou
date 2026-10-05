import { spawn } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { posix, sep } from "node:path";
import { findErrorCode } from "../storage/status.js";
import { BOARD_DEFAULT_AT } from "./declaration.js";
import { fromBytes } from "./glob.js";

/**
 * The files a board measure sees in one repository, at the working tree or at
 * a revision, keyed by their path from the repository root as a byte string
 * (one character per byte, see `toBytes`), always with '/'.
 *
 * At the working tree these are the tracked files and the untracked files git
 * does not ignore (`git ls-files --cached --others --exclude-standard`) that
 * exist on disk; at a revision, the files of that commit's tree. A symlink is
 * followed when it ends at a file inside the repository and is kept as
 * `outside` when it leaves it; one that ends nowhere or at a directory is not
 * a file and is left out, as a submodule is. A path that is there but cannot
 * be read is kept as `unreadable`, so it is reported rather than counted as
 * absent.
 */
export type ScopeEntry =
  | { kind: "file"; source: Buffer | string }
  | { kind: "outside" }
  | { kind: "unreadable"; reason: string };

export type ScopeRead = {
  contents: Map<string, Buffer>;
  /** Each path that could not be read, with why. */
  unreadable: Map<string, string>;
};

export type RepoScope = {
  /** `worktree`, or the revision as the declaration wrote it. */
  at: string;
  entries: ReadonlyMap<string, ScopeEntry>;
  /**
   * The directories git could not list in full in the working tree (one it
   * could not open, or whose ignore file it could not read), as byte strings
   * without a trailing '/' ("" for all of it), each with why. Files under one
   * may be missing from `entries`, or ignored ones present. Empty at a
   * revision.
   */
  unread: ReadonlyMap<string, string>;
  /** The contents of the given file entries, read together. */
  read(paths: readonly string[]): Promise<ScopeRead>;
};

export type RepoScopeResult = { ok: true; scope: RepoScope } | { ok: false; reason: string };

export type GitResult = {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  spawnError?: string;
};

// Variables that would point git at another repository, index or object
// store than the one asked about (git sets some of them for its hooks).
const LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCATION_VARIABLES) delete env[name];
  // Read without writing (no index refresh) and without the network: a
  // partial clone would otherwise fetch the objects it lacks from its remote.
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  // Messages in English, so the warnings below can be recognized.
  env.LC_ALL = "C";
  return env;
}

/**
 * Run git with an argument list (no shell), without the variables that point
 * it elsewhere, and without letting it write a lock, fetch, or start a file
 * system monitor (`core.fsmonitor` runs a hook or a daemon on `ls-files` and
 * `status`). A git that cannot be started is reported in the result, not
 * thrown.
 */
export function runGit(cwd: string, args: readonly string[], input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: GitResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd,
        env: gitEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      const empty = Buffer.alloc(0);
      done({ code: null, stdout: empty, stderr: empty, spawnError: spawnReason(error) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      const empty = Buffer.alloc(0);
      done({ code: null, stdout: empty, stderr: empty, spawnError: spawnReason(error) });
    });
    child.on("close", (code) =>
      done({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    );
    child.stdin?.on("error", () => {
      // git may exit before reading all of stdin; its exit code says why.
    });
    child.stdin?.end(input ?? "");
  });
}

// What git says, still exiting 0, when it could not read part of the working
// tree: a directory it could not open, an ignore file it could not read, a
// file it could not look at.
const UNREAD =
  /could not open directory|unable to access|Permission denied|Operation not permitted|Input\/output error/;

const OPEN_DIRECTORY = /^warning: could not open directory '(.*)': [^']*$/;
const ACCESS_FILE = /^warning: unable to access '(.*)': [^']*$/;

/**
 * Each warning in `result` that git could not read part of the working tree,
 * as a byte string. Git lists what it could see and exits 0 regardless, so a
 * listing with such a warning may leave files out (or count ignored ones in)
 * without a sign.
 */
export function unreadWarnings(result: GitResult): string[] {
  return result.stderr
    .toString("latin1")
    .split("\n")
    .filter((message) => UNREAD.test(message));
}

/** A warning of {@link unreadWarnings}, as text without its `warning: ` prefix. */
export function shownWarning(message: string): string {
  return fromBytes(message).replace(/^(warning|error): /, "");
}

// The directory a warning says git could not list in full: the one it could
// not open, or the one whose .gitignore it could not read; "" (all of the
// working tree) for anything else.
function unreadDirectory(message: string): string {
  const opened = OPEN_DIRECTORY.exec(message);
  if (opened !== null) return (opened[1] as string).replace(/\/$/, "");
  const accessed = ACCESS_FILE.exec(message)?.[1];
  if (accessed === undefined || accessed.startsWith("/") || accessed.startsWith(".git/")) return "";
  if (accessed === ".gitignore") return "";
  return accessed.endsWith("/.gitignore") ? accessed.slice(0, -"/.gitignore".length) : "";
}

function spawnReason(error: unknown): string {
  if (findErrorCode(error, "ENOENT"))
    return "could not be read: git is not installed or not in PATH";
  if (findErrorCode(error, "EACCES")) return "could not be read: permission denied";
  return "could not be read: git could not be started";
}

// Paths as byte strings, from git's NUL-separated output.
function splitNul(buf: Buffer): string[] {
  return buf
    .toString("latin1")
    .split("\0")
    .filter((s) => s.length > 0);
}

function codeReason(error: unknown): string {
  const code = ["EACCES", "EPERM", "EIO", "ELOOP", "EISDIR", "EMFILE"].find((c) =>
    findErrorCode(error, c),
  );
  return code === undefined ? "could not be read" : `could not be read (${code})`;
}

function isAbsent(error: unknown): boolean {
  return findErrorCode(error, "ENOENT") || findErrorCode(error, "ENOTDIR");
}

export type RepoRootResult = { ok: true; root: Buffer } | { ok: false; reason: string };

/**
 * The physical path of the repository at `repoRoot` (an absolute path), when
 * it is the root of a git repository. Not being one is reported, not thrown:
 * the directory is missing, cannot be read, is not in a git repository, or is
 * inside one but not at its root.
 */
export async function locateRepoRoot(repoRoot: string): Promise<RepoRootResult> {
  try {
    if (!(await stat(repoRoot)).isDirectory()) return { ok: false, reason: "is not a directory" };
  } catch (error: unknown) {
    return { ok: false, reason: isAbsent(error) ? "is not on disk" : codeReason(error) };
  }
  const top = await runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (top.spawnError !== undefined) return { ok: false, reason: top.spawnError };
  if (top.code !== 0) return { ok: false, reason: "is not a git repository" };
  let realRoot: Buffer;
  let topReal: Buffer;
  try {
    realRoot = await realpath(repoRoot, { encoding: "buffer" });
    topReal = await realpath(top.stdout.subarray(0, top.stdout.length - 1), { encoding: "buffer" });
  } catch (error: unknown) {
    return { ok: false, reason: codeReason(error) };
  }
  if (!topReal.equals(realRoot)) {
    return { ok: false, reason: "is inside a git repository but is not its root" };
  }
  return { ok: true, root: realRoot };
}

/**
 * Open the scope of the repository at `repoRoot` (an absolute path) for `at`.
 * Not being able to is reported, not thrown: the repository is missing, is
 * not the root of a git repository, cannot be read, or has no such commit.
 */
export async function openRepoScope(repoRoot: string, at: string): Promise<RepoScopeResult> {
  const located = await locateRepoRoot(repoRoot);
  if (!located.ok) return located;
  return at === BOARD_DEFAULT_AT ? openWorktree(located.root) : openRevision(located.root, at);
}

function within(root: Buffer, target: Buffer): boolean {
  if (target.equals(root)) return true;
  const boundary = root.length > 0 && root[root.length - 1] === sep.charCodeAt(0);
  return (
    target.length > root.length &&
    target.subarray(0, root.length).equals(root) &&
    (boundary || target[root.length] === sep.charCodeAt(0))
  );
}

function joinBytes(root: Buffer, path: string): Buffer {
  return Buffer.concat([root, Buffer.from(sep), Buffer.from(path, "latin1")]);
}

async function openWorktree(root: Buffer): Promise<RepoScopeResult> {
  const cwd = root.toString();
  const listed = await runGit(cwd, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (listed.spawnError !== undefined) return { ok: false, reason: listed.spawnError };
  if (listed.code !== 0) return { ok: false, reason: "could not be listed by git" };
  const unread = new Map<string, string>();
  for (const message of unreadWarnings(listed)) {
    const dir = unreadDirectory(message);
    if (!unread.has(dir)) {
      unread.set(dir, `git could not read all of the working tree ("${shownWarning(message)}")`);
    }
  }
  const entries = new Map<string, ScopeEntry>();
  // An unmerged path is listed once for each of its stages.
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
      unread,
      async read(want) {
        const result: ScopeRead = { contents: new Map(), unreadable: new Map() };
        for (const p of want) {
          const entry = entries.get(p);
          if (entry?.kind !== "file") continue;
          try {
            result.contents.set(p, await readFile(entry.source));
          } catch (error: unknown) {
            result.unreadable.set(p, codeReason(error));
          }
        }
        return result;
      },
    },
  };
}

async function worktreeEntry(root: Buffer, path: string): Promise<ScopeEntry | undefined> {
  const abs = joinBytes(root, path);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(abs);
  } catch (error: unknown) {
    if (isAbsent(error)) return undefined; // tracked but deleted from the working tree
    return { kind: "unreadable", reason: codeReason(error) };
  }
  if (info.isFile()) return { kind: "file", source: abs };
  if (!info.isSymbolicLink()) return undefined;
  let target: Buffer;
  try {
    target = await realpath(abs, { encoding: "buffer" });
  } catch (error: unknown) {
    if (isAbsent(error) || findErrorCode(error, "ELOOP")) return undefined; // ends nowhere
    return { kind: "unreadable", reason: codeReason(error) };
  }
  if (!within(root, target)) return { kind: "outside" };
  try {
    return (await stat(target)).isFile() ? { kind: "file", source: target } : undefined;
  } catch (error: unknown) {
    return isAbsent(error) ? undefined : { kind: "unreadable", reason: codeReason(error) };
  }
}

type TreeEntry = { mode: string; type: string; oid: string };

/** Whether git at this version honors GIT_NO_LAZY_FETCH (2.44 and later). */
export async function gitCanRefuseLazyFetch(cwd: string): Promise<boolean> {
  const version = await runGit(cwd, ["version"]);
  const m = /(\d+)\.(\d+)/.exec(version.stdout.toString("utf8"));
  if (m === null) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 44);
}

/** Whether the repository at `cwd` is a partial clone, which may lack objects. */
export async function isPartialClone(cwd: string): Promise<boolean> {
  const partial = await runGit(cwd, ["config", "--get", "extensions.partialclone"]);
  if (partial.code === 0) return true;
  const promisor = await runGit(cwd, ["config", "--get-regexp", "^remote\\..*\\.promisor$"]);
  return promisor.code === 0 && /\btrue\b/i.test(promisor.stdout.toString("utf8"));
}

async function openRevision(root: Buffer, at: string): Promise<RepoScopeResult> {
  const cwd = root.toString();
  if ((await isPartialClone(cwd)) && !(await gitCanRefuseLazyFetch(cwd))) {
    return {
      ok: false,
      reason:
        "is a partial clone, which this git (older than 2.44) may fetch objects for from its remote",
    };
  }
  const commit = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${at}^{commit}`]);
  if (commit.spawnError !== undefined) return { ok: false, reason: commit.spawnError };
  if (commit.code !== 0) {
    const any = await runGit(cwd, ["rev-parse", "--verify", "--quiet", at]);
    return {
      ok: false,
      reason: any.code === 0 ? `has '${at}', but it is not a commit` : `has no revision '${at}'`,
    };
  }
  const oid = commit.stdout.toString("utf8").trim();
  const tree = await runGit(cwd, ["ls-tree", "-r", "-t", "-z", "--full-tree", oid]);
  if (tree.code !== 0) return { ok: false, reason: `could not be listed by git at '${at}'` };
  const all = new Map<string, TreeEntry>();
  for (const record of splitNul(tree.stdout)) {
    const tab = record.indexOf("\t");
    const [mode, type, blob] = record.slice(0, tab).split(" ");
    if (mode === undefined || type === undefined || blob === undefined) continue;
    all.set(record.slice(tab + 1), { mode, type, oid: blob });
  }
  const linkOids = [...all.values()].filter((e) => e.mode === "120000").map((e) => e.oid);
  const linkTexts = (await catFile(cwd, linkOids)).blobs;
  const entries = new Map<string, ScopeEntry>();
  for (const [path, entry] of all) {
    if (entry.type !== "blob") continue; // a directory, or a submodule
    const resolved = entry.mode === "120000" ? resolveInTree(path, all, linkTexts) : entry;
    if (resolved === "outside") entries.set(path, { kind: "outside" });
    else if (resolved === "unreadable") {
      entries.set(path, { kind: "unreadable", reason: `could not be read at '${at}'` });
    } else if (resolved !== undefined) entries.set(path, { kind: "file", source: resolved.oid });
  }
  return {
    ok: true,
    scope: {
      at,
      entries,
      unread: new Map(),
      async read(want) {
        const oids = new Map<string, string>();
        for (const p of want) {
          const entry = entries.get(p);
          if (entry?.kind === "file" && typeof entry.source === "string") oids.set(p, entry.source);
        }
        const { blobs } = await catFile(cwd, [...new Set(oids.values())]);
        const result: ScopeRead = { contents: new Map(), unreadable: new Map() };
        for (const [p, blobOid] of oids) {
          const blob = blobs.get(blobOid);
          if (blob === undefined) result.unreadable.set(p, `could not be read at '${at}'`);
          else result.contents.set(p, blob);
        }
        return result;
      },
    },
  };
}

// Follow a path of the tree through every symlink on it, one component at a
// time, to the file it ends at: "outside" when it leaves the repository,
// "unreadable" when a link's target cannot be read, undefined when it ends
// nowhere, at a directory, at a submodule, or in a loop.
function resolveInTree(
  path: string,
  all: ReadonlyMap<string, TreeEntry>,
  linkTexts: ReadonlyMap<string, Buffer>,
): TreeEntry | "outside" | "unreadable" | undefined {
  let parts = path.split("/");
  let i = 0;
  for (let hops = 0; hops <= 40; ) {
    if (i >= parts.length) return undefined;
    const prefix = parts.slice(0, i + 1).join("/");
    const entry = all.get(prefix);
    if (entry === undefined) return undefined;
    if (entry.mode === "120000") {
      hops++;
      const text = linkTexts.get(entry.oid)?.toString("latin1");
      if (text === undefined) return "unreadable";
      if (text.startsWith("/")) return "outside";
      const joined = posix.normalize(
        posix.join(parts.slice(0, i).join("/"), text, ...parts.slice(i + 1)),
      );
      if (joined === ".." || joined.startsWith("../")) return "outside";
      parts = joined.split("/").filter((s) => s !== "" && s !== ".");
      i = 0;
      continue;
    }
    if (i === parts.length - 1) return entry.type === "blob" ? entry : undefined;
    if (entry.type !== "tree") return undefined;
    i++;
  }
  return undefined;
}

// Read blobs with one `git cat-file --batch`. A blob git reports missing, or
// does not get to because it failed, is absent from the result.
async function catFile(
  cwd: string,
  oids: readonly string[],
): Promise<{ blobs: Map<string, Buffer> }> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return { blobs };
  const result = await runGit(cwd, ["cat-file", "--batch"], `${oids.join("\n")}\n`);
  const buf = result.stdout;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.subarray(pos, nl).toString("latin1").split(" ");
    pos = nl + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    if (!Number.isInteger(size) || pos + size > buf.length) break;
    blobs.set(header[0] as string, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return { blobs };
}

/**
 * Why the given paths of a scope cannot all be measured: one is a symlink
 * that leaves the repository, or cannot be read. undefined when none is.
 */
export function blockedAmong(scope: RepoScope, paths: readonly string[]): string | undefined {
  for (const p of paths) {
    const entry = scope.entries.get(p);
    if (entry?.kind === "outside")
      return `'${shownPath(p)}' is a symlink to outside the repository`;
    if (entry?.kind === "unreadable") return `'${shownPath(p)}' ${entry.reason}`;
  }
  return undefined;
}

/**
 * Why a measure cannot be trusted: `reach` says it may count what lies under
 * one of the directories git could not list in full. undefined when it may
 * not.
 */
export function unreadReaching(
  scope: RepoScope,
  reach: (dir: string) => boolean,
): string | undefined {
  for (const [dir, reason] of scope.unread) if (reach(dir)) return reason;
  return undefined;
}

/** Whether the path `path` is `dir`, is under it, or holds it (byte strings, "" for the root). */
export function reaches(path: string, dir: string): boolean {
  return (
    path === "" ||
    dir === "" ||
    path === dir ||
    path.startsWith(`${dir}/`) ||
    dir.startsWith(`${path}/`)
  );
}

/** The text of a scope path, for a message. */
export function shownPath(path: string): string {
  return fromBytes(path);
}
