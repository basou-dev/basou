import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { boardLivePage, measureBoardLive } from "./live.js";

const NULL_CONFIG = process.platform === "win32" ? "\\\\.\\nul" : "/dev/null";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: NULL_CONFIG, GIT_CONFIG_SYSTEM: NULL_CONFIG };
const NOW = new Date("2026-10-05T03:00:00.000Z");
const WITH = { basou: "0.0.0-test", build: null };
const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s}`;
// A dry run of an import that finds nothing to import, in place of the one
// the CLI passes, which reads the host's native logs.
const NOTHING_TO_IMPORT = async () => ({
  newSessions: 0,
  updatedSessions: 0,
  unverifiableSessions: 0,
});

let root: string;
let paths: BasouPaths;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, env: GIT_ENV, stdio: "pipe" }).toString();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "basou-board-live-")));
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "user.email", "t@e.com");
  git("config", "user.name", "t");
  await writeFile(join(root, ".gitignore"), ".basou/\n");
  await writeFile(join(root, "package.json"), "{}\n");
  await mkdir(join(root, "web"));
  await writeFile(join(root, "web", "package.json"), "{}\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  paths = await ensureBasouDirectory(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function placeStarted(id: string, startedAt: string): Promise<void> {
  const dir = join(paths.sessions, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session.yaml"),
    stringify({
      schema_version: "0.1.0",
      session: {
        id,
        label: "fixture",
        task_id: null,
        workspace_id: "ws_01HXABCDEF1234567890ABCDEF",
        source: { kind: "terminal", version: "0.1.0" },
        started_at: startedAt,
        status: "completed",
        working_directory: "/tmp/fixture",
        invocation: { command: "echo", args: [], exit_code: 0 },
        related_files: [],
        events_log: "events.jsonl",
      },
    }),
  );
  await writeFile(join(dir, "events.jsonl"), "");
}

// Every path under a directory with, for a file, its size, modification time
// and content, for telling that nothing was written, created or touched.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out[path] = "dir";
      Object.assign(out, await snapshot(path));
    } else {
      const s = await stat(path, { bigint: true });
      const sha = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      out[path] = `${s.size}:${s.mtimeNs}:${sha}`;
    }
  }
  return out;
}

const measure = () =>
  measureBoardLive({
    root,
    repos: ["."],
    paths,
    now: NOW,
    measuredWith: WITH,
    probeImports: NOTHING_TO_IMPORT,
  });

describe("measureBoardLive", () => {
  it("measures the built-in sections a board needs no declaration for, and nothing else", async () => {
    await placeStarted(SES("S01"), "2026-10-01T00:00:00Z");
    const m = await measure();
    expect(Object.keys(m).sort()).toEqual(
      [
        "measured_at",
        "measured_with",
        "complete",
        "not_found",
        "methods",
        "repos",
        "trail",
        "integrity",
        "review_gaps",
        "freshness",
        "effort",
        "components",
      ].sort(),
    );
    expect(m.methods).toEqual({
      repos: 1,
      trail: 1,
      integrity: 1,
      review_gaps: 1,
      freshness: 1,
      effort: 1,
      components: 2,
    });
    expect(m.not_found).toEqual([]);
    expect(m.complete).toBe(true);
    expect(m.measured_at).toBe(NOW.toISOString());
    expect(m.repos).toMatchObject([{ path: ".", branch: "main", commits: 1, uncommitted: 0 }]);
    expect(m.trail).toEqual({ decisions_all: 0, decisions_live: 0, tracks_open: [] });
    expect(m.freshness).toEqual({
      newest_session_at: "2026-10-01T00:00:00Z",
      unimported: { new: 0, updated: 0, unverifiable: 0 },
    });
    // From the day of the first session, in this host's time zone.
    expect(m.effort.daily?.[0]?.date).toBe(m.effort.start);
    expect(m.effort.time_zone).not.toBeNull();
    const name = basename(root);
    expect(m.components).toEqual({ [name]: ["manifest"], [`${name}/web`]: ["manifest"] });
  });

  it("writes nothing", async () => {
    await placeStarted(SES("S01"), "2026-10-01T00:00:00Z");
    // Before the snapshot: git status itself may refresh the index.
    const status = git("status", "--porcelain");
    const before = await snapshot(root);
    await measure();
    // Every file of the repository, its .git and its .basou/ included.
    expect(await snapshot(root)).toEqual(before);
    expect(Object.keys(before).some((p) => p.endsWith(join(".git", "index")))).toBe(true);
    expect(git("status", "--porcelain")).toBe(status);
  });

  it("says what it could not measure, and is not complete then", async () => {
    const m = await measureBoardLive({
      root,
      repos: [".", "../missing"],
      paths,
      now: NOW,
      measuredWith: WITH,
    });
    expect(m.complete).toBe(false);
    const at = m.not_found.map((n) => n.at);
    expect(at).toContain("repos[../missing]");
    // No dry run of an import was given, so the sessions not imported are not known.
    expect(at).toContain("freshness.unimported");
    expect(m.components).toBeNull();
  });
});

describe("boardLivePage", () => {
  it("lays the measurement out for the page, under the workspace's name", async () => {
    await placeStarted(SES("S01"), "2026-10-01T00:00:00Z");
    const m = await measure();
    const page = boardLivePage("ws", m);
    const name = basename(root);
    expect(page.heading).toEqual({
      title: "ws",
      measured_at: NOW.toISOString(),
      complete: true,
      not_found: 0,
    });
    expect(page.effort.milestones).toEqual([]);
    expect(page.effort.daily?.length).toBe(page.effort.period_days);
    expect(page.integrity.sessions).toBe(1);
    expect(page.components).toEqual([
      { key: name, kinds: ["manifest"] },
      { key: `${name}/web`, kinds: ["manifest"] },
    ]);
    expect(page.repos[0]).not.toHaveProperty("files");
    expect(page.footnotes).toEqual({ not_found: [], measured_with: WITH });
  });
});
