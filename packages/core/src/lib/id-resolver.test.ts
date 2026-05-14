import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { resolveSessionId, resolveTaskId } from "./id-resolver.js";

const SES_A = "ses_01HXABCDEF1234567890ABCDE0";
const SES_B = "ses_01HXABCDEF1234567890ABCDE1";
const TASK_A = "task_01HXABCDEF1234567890ABCDE0";
const TASK_B = "task_01HXABCDEF1234567890ABCDE1";
const WS_ID = "ws_01HXABCDEF1234567890ABCWS1";
const OCC_AT = "2026-05-11T12:00:00+09:00";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-id-resolver-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

async function setupPaths(): Promise<BasouPaths> {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return ensureBasouDirectory(workDir);
}

async function placeSessionDir(paths: BasouPaths, id: string): Promise<void> {
  await mkdir(join(paths.sessions, id), { recursive: true });
}

async function placeTaskFile(paths: BasouPaths, id: string): Promise<void> {
  const yaml = stringifyYaml({
    schema_version: "0.1.0",
    task: {
      id,
      title: "x",
      status: "planned",
      created_at: OCC_AT,
      updated_at: OCC_AT,
      workspace_id: WS_ID,
      created_in_session: SES_A,
      linked_sessions: [SES_A],
    },
  });
  await writeFile(join(paths.tasks, `${id}.md`), `---\n${yaml}---\n\n`);
}

describe("resolveSessionId", () => {
  it("rejects empty input", async () => {
    const paths = await setupPaths();
    await expect(resolveSessionId(paths, "  ")).rejects.toThrow("Session id is empty");
  });

  it("returns the full id when a unique prefix is supplied", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, SES_A);
    const resolved = await resolveSessionId(paths, SES_A.slice(0, 12));
    expect(resolved).toBe(SES_A);
  });

  it("accepts an input that already carries the ses_ prefix", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, SES_A);
    expect(await resolveSessionId(paths, SES_A)).toBe(SES_A);
  });

  it("rejects an ambiguous prefix with the dedicated message", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, SES_A);
    await placeSessionDir(paths, SES_B);
    await expect(resolveSessionId(paths, "ses_01HXABCDEF1234567890ABCDE")).rejects.toThrow(
      /Ambiguous session id 'ses_01HXABCDEF1234567890ABCDE': matched 2 sessions/,
    );
  });

  it("rejects with Session not found when nothing matches", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, SES_A);
    await expect(resolveSessionId(paths, "ses_ZZZ")).rejects.toThrow("Session not found: ses_ZZZ");
  });

  it("rejects with Session not found when the prefix is bare", async () => {
    const paths = await setupPaths();
    await expect(resolveSessionId(paths, "ses_")).rejects.toThrow("Session not found: ses_");
  });
});

describe("resolveTaskId", () => {
  it("rejects empty input", async () => {
    const paths = await setupPaths();
    await expect(resolveTaskId(paths, "")).rejects.toThrow("Task id is empty");
  });

  it("returns the full id when a unique prefix is supplied", async () => {
    const paths = await setupPaths();
    await placeTaskFile(paths, TASK_A);
    const resolved = await resolveTaskId(paths, TASK_A.slice(0, 14));
    expect(resolved).toBe(TASK_A);
  });

  it("accepts an input that already carries the task_ prefix", async () => {
    const paths = await setupPaths();
    await placeTaskFile(paths, TASK_A);
    expect(await resolveTaskId(paths, TASK_A)).toBe(TASK_A);
  });

  it("rejects an ambiguous prefix with the dedicated message", async () => {
    const paths = await setupPaths();
    await placeTaskFile(paths, TASK_A);
    await placeTaskFile(paths, TASK_B);
    await expect(resolveTaskId(paths, "task_01HXABCDEF1234567890ABCDE")).rejects.toThrow(
      /Ambiguous task id 'task_01HXABCDEF1234567890ABCDE': matched 2 tasks/,
    );
  });

  it("rejects with Task not found when nothing matches", async () => {
    const paths = await setupPaths();
    await placeTaskFile(paths, TASK_A);
    await expect(resolveTaskId(paths, "task_ZZZ")).rejects.toThrow("Task not found: task_ZZZ");
  });

  it("rejects with Task not found when the prefix is bare", async () => {
    const paths = await setupPaths();
    await expect(resolveTaskId(paths, "task_")).rejects.toThrow("Task not found: task_");
  });
});
