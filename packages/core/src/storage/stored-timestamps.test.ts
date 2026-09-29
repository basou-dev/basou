import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ReplayWarning, readAllEvents } from "../events/event-replay.js";
import { verifyEventsChain } from "../events/verify.js";
import { type BasouPaths, ensureBasouDirectory } from "./basou-dir.js";
import { loadSessionEntries, readSessionYaml } from "./sessions.js";

/**
 * A session exactly as `basou session import` at 0.44.0 wrote it, from a
 * producer payload whose timestamps omit seconds. Before event `0.3.0` (and
 * session `0.2.0`) the accepted shape allowed that, and the importer stored
 * the producer's values as given; these bytes were captured from that release.
 */
const SESSION_ID = "ses_01M3PWQAZBN24WGZBF29B3F7R8";
const SESSION_YAML = `schema_version: 0.1.0
session:
  id: ses_01M3PWQAZBN24WGZBF29B3F7R8
  task_id: null
  workspace_id: ws_01M3PWQ1WYXGYT1T75WFX7D5NQ
  source:
    kind: import
    version: 0.1.0
  started_at: 2026-09-16T01:23Z
  ended_at: 2026-09-16T01:30Z
  status: imported
  working_directory: ~/somewhere
  invocation:
    command: producer
    args: []
    exit_code: 0
  related_files: []
  events_log: events.jsonl
  summary: null
  integrity:
    head_hash: 93602ccdcde550a3b3dd838b8ff2f7fda5fae4f23c6198845c2212bb529bb37f
    event_count: 4
`;
const EVENTS_JSONL = [
  '{"schema_version":"0.2.0","id":"evt_01M3PWQAZBN24WGZBF29B3F7R9","session_id":"ses_01M3PWQAZBN24WGZBF29B3F7R8","occurred_at":"2026-09-16T01:23Z","source":"third-party","type":"session_started","prev_hash":"3aebe78ef6041c11a10a1b02c12594ac57238fc1107a57dfc111bdc61810ef94"}',
  '{"schema_version":"0.2.0","id":"evt_01M3PWQAZBN24WGZBF29B3F7RA","session_id":"ses_01M3PWQAZBN24WGZBF29B3F7R8","occurred_at":"2026-09-16T01:24Z","source":"third-party","type":"note_added","body":"written by a producer","prev_hash":"df53480c835ee43cfa68531da59e7f10baa5f07a1af2c8e08cdff29b27a10b04"}',
  '{"schema_version":"0.2.0","id":"evt_01M3PWQAZBN24WGZBF29B3F7RB","session_id":"ses_01M3PWQAZBN24WGZBF29B3F7R8","occurred_at":"2026-09-16T01:24:30Z","source":"third-party","type":"note_added","body":"this one has seconds","prev_hash":"9a32a5119783c5133b7a9f07e6d05818aa5f18adc7cdd63a667eec2092759f59"}',
  '{"schema_version":"0.2.0","id":"evt_01M3PWQAZBN24WGZBF29B3F7RC","session_id":"ses_01M3PWQAZBN24WGZBF29B3F7R8","occurred_at":"2026-09-16T01:30Z","source":"third-party","type":"session_ended","prev_hash":"3efc2188570eb52b4981d4d95b8b289b888ac9ca542f500e32721381d71e18a6"}',
]
  .map((line) => `${line}\n`)
  .join("");

let workDir: string;
let paths: BasouPaths;
let sessionDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-stored-timestamps-test-"));
  paths = await ensureBasouDirectory(workDir);
  sessionDir = join(paths.sessions, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "session.yaml"), SESSION_YAML);
  await writeFile(join(sessionDir, "events.jsonl"), EVENTS_JSONL);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("a session an older basou imported with seconds-less timestamps", () => {
  it("is read, with each timestamp restored to :00 and its offset kept", async () => {
    const session = await readSessionYaml(paths, SESSION_ID);
    expect(session.session.started_at).toBe("2026-09-16T01:23:00Z");
    expect(session.session.ended_at).toBe("2026-09-16T01:30:00Z");
  });

  it("is listed rather than skipped as an invalid session", async () => {
    const skipped: string[] = [];
    const entries = await loadSessionEntries(paths, {
      now: new Date("2026-09-30T00:00:00Z"),
      onSkip: (sid, reason) => skipped.push(`${sid}:${reason}`),
    });
    expect(skipped).toEqual([]);
    expect(entries.map((entry) => entry.sessionId)).toEqual([SESSION_ID]);
  });

  it("yields every event, not only the one that carried seconds", async () => {
    const warnings: ReplayWarning[] = [];
    const events = await readAllEvents(sessionDir, { onWarning: (w) => warnings.push(w) });
    expect(warnings).toEqual([]);
    expect(events.map((event) => event.occurred_at)).toEqual([
      "2026-09-16T01:23:00Z",
      "2026-09-16T01:24:00Z",
      "2026-09-16T01:24:30Z",
      "2026-09-16T01:30:00Z",
    ]);
  });

  it("verifies, instead of reporting the unreadable anchor as tampering", async () => {
    const verdict = await verifyEventsChain(paths, SESSION_ID);
    expect(verdict.status).toBe("verified");
  });

  it("is not rewritten by being read", async () => {
    await readSessionYaml(paths, SESSION_ID);
    await readAllEvents(sessionDir);
    await verifyEventsChain(paths, SESSION_ID);
    expect(await readFile(join(sessionDir, "session.yaml"), "utf8")).toBe(SESSION_YAML);
    expect(await readFile(join(sessionDir, "events.jsonl"), "utf8")).toBe(EVENTS_JSONL);
  });
});
