import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { renderDecisions } from "./decisions-renderer.js";

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_NOW_ISO = "2026-05-09T03:00:00.000Z";

const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s}`;
const EVT = (s: string): string => `evt_01HXABCDEF1234567890ABC${s}`;
const DEC = (s: string): string => `decision_01HXABCDEF1234567890ABC${s}`;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-decisions-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

async function setupPaths(): Promise<BasouPaths> {
  return ensureBasouDirectory(getWorkDir());
}

async function placeSession(
  paths: BasouPaths,
  id: string,
  startedAt: string,
  events?: string,
): Promise<void> {
  const sessionDir = join(paths.sessions, id);
  await mkdir(sessionDir, { recursive: true });
  const yaml = stringify({
    schema_version: "0.1.0",
    session: {
      id,
      label: `fixture ${id.slice(-3)}`,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal", version: "0.1.0" },
      started_at: startedAt,
      status: "completed",
      working_directory: "/tmp/fixture",
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
  await writeFile(join(sessionDir, "session.yaml"), yaml);
  if (events !== undefined) await writeFile(join(sessionDir, "events.jsonl"), events);
}

function decisionLine(
  sessionId: string,
  evt: string,
  decisionId: string,
  title: string,
  occurredAt: string,
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "decision_recorded",
    id: EVT(evt),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "human",
    decision_id: decisionId,
    title,
  })}\n`;
}

describe("decisions-renderer", () => {
  it("case 1: empty workspace produces the no-decisions placeholder", async () => {
    const paths = await setupPaths();
    const result = await renderDecisions({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.decisionCount).toBe(0);
    expect(result.body).toContain("# Decisions");
    expect(result.body).toContain(`> Generated at ${FIXED_NOW_ISO}`);
    expect(result.body).toContain("(no decisions recorded yet)");
  });

  it("case 2: a single decision renders the 4-field section", async () => {
    const paths = await setupPaths();
    const sid = SES("X01");
    const did = DEC("D01");
    await placeSession(
      paths,
      sid,
      "2026-05-08T11:00:00+09:00",
      decisionLine(sid, "E01", did, "use zod", "2026-05-08T11:30:00+09:00"),
    );
    const result = await renderDecisions({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.decisionCount).toBe(1);
    expect(result.body).toContain(`## ${did}: use zod`);
    expect(result.body).toContain("- 決定日: 2026-05-08");
    expect(result.body).toContain("- session:");
    expect(result.body).toContain("- 判断: use zod");
  });

  it("case 3: aggregates decisions across multiple sessions in chronological order", async () => {
    const paths = await setupPaths();
    const sidA = SES("X02");
    const sidB = SES("X03");
    const dec1 = DEC("D02");
    const dec2 = DEC("D03");
    const dec3 = DEC("D04");
    await placeSession(
      paths,
      sidA,
      "2026-05-08T11:00:00+09:00",
      decisionLine(sidA, "E02", dec1, "first", "2026-05-08T11:00:00+09:00") +
        decisionLine(sidA, "E03", dec3, "third", "2026-05-08T13:00:00+09:00"),
    );
    await placeSession(
      paths,
      sidB,
      "2026-05-08T12:00:00+09:00",
      decisionLine(sidB, "E04", dec2, "second", "2026-05-08T12:00:00+09:00"),
    );
    const result = await renderDecisions({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.decisionCount).toBe(3);
    const idx1 = result.body.indexOf("first");
    const idx2 = result.body.indexOf("second");
    const idx3 = result.body.indexOf("third");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("case 4: same occurred_at falls back to decisionId ascending", async () => {
    const paths = await setupPaths();
    const sid = SES("X04");
    const decA = DEC("DA0");
    const decB = DEC("DB0");
    const sameTime = "2026-05-08T11:00:00+09:00";
    // Place B before A in the file so a stable sort would keep file order;
    // the sort key must promote A above B.
    await placeSession(
      paths,
      sid,
      sameTime,
      decisionLine(sid, "E05", decB, "B title", sameTime) +
        decisionLine(sid, "E06", decA, "A title", sameTime),
    );
    const result = await renderDecisions({ paths, nowIso: FIXED_NOW_ISO });
    const idxA = result.body.indexOf("A title");
    const idxB = result.body.indexOf("B title");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });

  it("case 5: a session with no decision_recorded events does not emit a section", async () => {
    const paths = await setupPaths();
    await placeSession(paths, SES("X05"), "2026-05-08T11:00:00+09:00", "");
    const result = await renderDecisions({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.decisionCount).toBe(0);
    expect(result.body).toContain("(no decisions recorded yet)");
  });

  it("case 6: partial trailing line surfaces a warning but renders the prior decisions", async () => {
    const paths = await setupPaths();
    const sid = SES("X06");
    const did = DEC("D05");
    const events = `${decisionLine(sid, "E07", did, "ok", "2026-05-08T11:00:00+09:00")}{"schema_version":"0.1.0","type":"session_started","oops`;
    await placeSession(paths, sid, "2026-05-08T11:00:00+09:00", events);
    const warnings: string[] = [];
    const result = await renderDecisions({
      paths,
      nowIso: FIXED_NOW_ISO,
      onWarning: (w) => warnings.push(w.kind),
    });
    expect(result.decisionCount).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("case 7: missing events.jsonl is silently ignored", async () => {
    const paths = await setupPaths();
    await placeSession(paths, SES("X07"), "2026-05-08T11:00:00+09:00"); // no events
    const result = await renderDecisions({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.decisionCount).toBe(0);
  });

  it("case 8: nowIso is reflected in the generated_at header", async () => {
    const paths = await setupPaths();
    const customNow = "2026-12-31T23:59:59.000Z";
    const result = await renderDecisions({ paths, nowIso: customNow });
    expect(result.body).toContain(`> Generated at ${customNow}`);
  });
});
