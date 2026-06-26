import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunReviewGaps, parseWindow } from "./review-gaps.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const WS = "ws_01HXABCDEF1234567890ABCDEF";
const NOW = new Date("2026-05-10T00:00:00.000Z");
const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s.padStart(3, "0")}`;

let tmpRepo: string | undefined;
beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-rg-cli-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
});
afterEach(async () => {
  if (tmpRepo !== undefined) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});
function repo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

async function setupWorkspace(): Promise<void> {
  const paths = await ensureBasouDirectory(repo());
  await writeManifest(paths, createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS }));
}

async function placeCommitSession(): Promise<void> {
  const paths = basouPaths(repo());
  const dir = join(paths.sessions, SES("C1"));
  await mkdir(dir, { recursive: true });
  await writeYamlFile(join(dir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: SES("C1"),
      label: "commit fixture",
      task_id: null,
      workspace_id: WS,
      source: { kind: "claude-code-import", version: "0.1.0" },
      started_at: "2026-05-09T10:00:00.000Z",
      status: "imported",
      working_directory: "/tmp/fixture",
      invocation: { command: "claude", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({
      schema_version: "0.1.0",
      id: "evt_01HXABCDEF1234567890AB0001",
      session_id: SES("C1"),
      occurred_at: "2026-05-09T10:05:00.000Z",
      source: "claude-code-import",
      type: "command_executed",
      command: "bash",
      args: ["-c", "cd /home/u/projects/alpha && git commit -m x"],
      cwd: "/x",
      exit_code: 0,
      duration_ms: 0,
    })}\n`,
  );
}

describe("parseWindow", () => {
  it("accepts a positive integer and rejects zero / negatives / non-integers", () => {
    expect(parseWindow("12")).toBe(12);
    expect(() => parseWindow("0")).toThrow(/positive integer/);
    expect(() => parseWindow("-3")).toThrow(/positive integer/);
    expect(() => parseWindow("1.5")).toThrow(/positive integer/);
    expect(() => parseWindow("abc")).toThrow(/positive integer/);
  });
});

describe("basou review-gaps", () => {
  it("resolves the workspace and returns the structured summary", async () => {
    await setupWorkspace();
    await placeCommitSession();
    const summary = await doRunReviewGaps({ json: true }, { cwd: repo(), nowProvider: () => NOW });
    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0]?.repo).toBe("alpha");
    expect(summary.gaps[0]?.verdict).toBe("omission");
  });

  it("prints the human report by default and JSON with --json", async () => {
    await setupWorkspace();
    await placeCommitSession();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => String(x)).join(" "));
    });
    try {
      await doRunReviewGaps({}, { cwd: repo(), nowProvider: () => NOW });
      await doRunReviewGaps({ json: true }, { cwd: repo(), nowProvider: () => NOW });
    } finally {
      spy.mockRestore();
    }
    expect(logs[0]).toContain("Review-trail gaps");
    const parsed = JSON.parse(logs[1] ?? "{}");
    expect(parsed.gaps[0].repo).toBe("alpha");
  });

  it("scope restricts the report to the named repo", async () => {
    await setupWorkspace();
    await placeCommitSession();
    const summary = await doRunReviewGaps(
      { repo: ["beta"], json: true },
      { cwd: repo(), nowProvider: () => NOW },
    );
    expect(summary.scope).toEqual(["beta"]);
    expect(summary.gaps).toHaveLength(0); // the only commit is in alpha
  });
});
