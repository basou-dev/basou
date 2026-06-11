import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { appendChainedEvent } from "../events/chained-append.js";
import { verifyEventsChain } from "../events/verify.js";
import type { PrefixedId } from "../ids/ulid.js";
import type { Event } from "../schemas/event.schema.js";
import { appendEventToExistingSession } from "./ad-hoc-session.js";
import { type BasouPaths, basouPaths, ensureBasouDirectory } from "./basou-dir.js";
import {
  classifySuspect,
  enumerateSessionDirs,
  finalizeSessionYaml,
  loadSessionEntries,
  readSessionYaml,
  type SessionSkipReason,
} from "./sessions.js";

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

// Crockford base32 body (no I/L/O/U), 23-char base + 3-char suffix = 26 chars.
// Each suffix differs in the trailing chars so prefixes remain unique under
// the ULID-ascending sort assumption.
const SES = (suffix: string): string => `ses_01HXABCDEF1234567890ABC${suffix}`;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-sessions-test-"));
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

type SessionFixture = {
  id: string;
  status?:
    | "initialized"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "interrupted"
    | "imported";
  startedAt?: string;
  endedAt?: string;
  relatedFiles?: string[];
};

function makeSessionYaml(fixture: SessionFixture): string {
  return stringify({
    schema_version: "0.1.0",
    session: {
      id: fixture.id,
      label: `fixture ${fixture.id.slice(-4)}`,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal" as const, version: "0.1.0" as const },
      started_at: fixture.startedAt ?? "2026-05-08T11:00:00+09:00",
      ...(fixture.endedAt !== undefined ? { ended_at: fixture.endedAt } : {}),
      status: fixture.status ?? "completed",
      working_directory: "/tmp/fixture",
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: fixture.relatedFiles ?? [],
      events_log: "events.jsonl",
    },
  });
}

async function placeSession(
  paths: BasouPaths,
  fixture: SessionFixture,
  events?: string,
): Promise<void> {
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "session.yaml"), makeSessionYaml(fixture));
  if (events !== undefined) {
    await writeFile(join(sessionDir, "events.jsonl"), events);
  }
}

function makeNote(id: string, evt: string): Event {
  return {
    schema_version: "0.1.0",
    type: "note_added",
    id: `evt_01HXABCDEF1234567890ABC${evt}`,
    session_id: id,
    occurred_at: "2026-06-12T09:00:00+09:00",
    source: "local-cli",
    body: `note ${evt}`,
  } as Event;
}

describe("finalizeSessionYaml", () => {
  it("stamps the head anchor from a chained log and yields a verified session", async () => {
    const paths = await setupPaths();
    const id = SES("FZ1");
    await placeSession(paths, { id, status: "running" });
    await appendChainedEvent(paths, id, makeNote(id, "NA1"));
    await appendChainedEvent(paths, id, makeNote(id, "NB1"));
    await finalizeSessionYaml(paths, id, (s) => {
      s.session.status = "completed";
      s.session.ended_at = "2026-06-12T10:00:00+09:00";
      s.session.invocation.exit_code = 0;
    });
    const session = await readSessionYaml(paths, id);
    expect(session.session.status).toBe("completed");
    expect(session.session.integrity).toBeDefined();
    expect(await verifyEventsChain(paths, id)).toEqual({ status: "verified", eventCount: 2 });
  });

  it("leaves no anchor for an unchained (legacy) log and reports it unchained", async () => {
    const paths = await setupPaths();
    const id = SES("FZ2");
    const plain = JSON.stringify(makeNote(id, "NA2"));
    await placeSession(paths, { id, status: "running" }, `${plain}\n`);
    await finalizeSessionYaml(paths, id, (s) => {
      s.session.status = "completed";
    });
    const session = await readSessionYaml(paths, id);
    expect(session.session.integrity).toBeUndefined();
    expect((await verifyEventsChain(paths, id)).status).toBe("unchained");
  });

  it("keeps the chain verified when a foreign attach interleaves a running session", async () => {
    const paths = await setupPaths();
    const id = SES("FZ3");
    await placeSession(paths, { id, status: "running" });
    // Orchestrator append, then a foreign attach (decision/note gateway), then
    // another orchestrator append, then finalize. All chain onto the true tail.
    await appendChainedEvent(paths, id, makeNote(id, "NA3"));
    await appendEventToExistingSession({
      paths,
      sessionId: id as PrefixedId<"ses">,
      eventBuilder: (eventId) =>
        ({
          schema_version: "0.1.0",
          type: "note_added",
          id: eventId,
          session_id: id,
          occurred_at: "2026-06-12T09:30:00+09:00",
          source: "local-cli",
          body: "attached note",
        }) as Event,
    });
    await appendChainedEvent(paths, id, makeNote(id, "NB3"));
    await finalizeSessionYaml(paths, id, (s) => {
      s.session.status = "completed";
      s.session.ended_at = "2026-06-12T10:00:00+09:00";
      s.session.invocation.exit_code = 0;
    });
    expect(await verifyEventsChain(paths, id)).toEqual({ status: "verified", eventCount: 3 });
  });
});

function sessionStartedLine(id: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_started",
    id: `evt_01HXABCDEF1234567890ABC${evt}`,
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
  })}\n`;
}

function sessionEndedLine(id: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_ended",
    id: `evt_01HXABCDEF1234567890ABC${evt}`,
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
    final_status: "completed",
  })}\n`;
}

describe("storage/sessions", () => {
  describe("enumerateSessionDirs", () => {
    it("case 1: lists session dirs in ULID-ascending order and filters non-dirs", async () => {
      const paths = await setupPaths();
      // intentionally placed in non-sorted order so the .sort() effect is visible
      await mkdir(join(paths.sessions, SES("XB1")), { recursive: true });
      await mkdir(join(paths.sessions, SES("XA1")), { recursive: true });
      await mkdir(join(paths.sessions, SES("XC1")), { recursive: true });
      await writeFile(join(paths.sessions, ".gitkeep"), "");
      const ids = await enumerateSessionDirs(paths);
      expect(ids).toEqual([SES("XA1"), SES("XB1"), SES("XC1")]);
    });

    it("case 2: returns [] when the sessions directory does not exist", async () => {
      const paths = basouPaths(getWorkDir()); // never ensureBasouDirectory'd
      const ids = await enumerateSessionDirs(paths);
      expect(ids).toEqual([]);
    });

    it("case 3: filters non-directory entries (e.g. stray foo.yaml)", async () => {
      const paths = await setupPaths();
      await mkdir(join(paths.sessions, SES("XA2")), { recursive: true });
      await writeFile(join(paths.sessions, "foo.yaml"), "noise");
      const ids = await enumerateSessionDirs(paths);
      expect(ids).toEqual([SES("XA2")]);
    });
  });

  describe("readSessionYaml", () => {
    it("case 4: returns the parsed Session for a valid file", async () => {
      const paths = await setupPaths();
      const id = SES("XA3");
      await placeSession(paths, { id, status: "completed" });
      const session = await readSessionYaml(paths, id);
      expect(session.session.id).toBe(id);
      expect(session.session.status).toBe("completed");
    });

    it("case 5: re-throws yaml-store's 'YAML file not found' on ENOENT", async () => {
      const paths = await setupPaths();
      const id = SES("XA4");
      await mkdir(join(paths.sessions, id), { recursive: true });
      await expect(readSessionYaml(paths, id)).rejects.toMatchObject({
        message: "YAML file not found",
      });
    });

    it("case 6: throws 'Failed to read session.yaml' for schema violation", async () => {
      const paths = await setupPaths();
      const id = SES("XA5");
      const sessionDir = join(paths.sessions, id);
      await mkdir(sessionDir, { recursive: true });
      // syntactically valid YAML, but missing required fields → schema fails
      await writeFile(
        join(sessionDir, "session.yaml"),
        stringify({ schema_version: "0.1.0", session: { id } }),
      );
      await expect(readSessionYaml(paths, id)).rejects.toMatchObject({
        message: "Failed to read session.yaml",
      });
    });
  });

  describe("classifySuspect", () => {
    it("case 8a: Rule A — running yaml + session_ended event", async () => {
      const paths = await setupPaths();
      const id = SES("XA6");
      const events =
        sessionStartedLine(id, "E0A", "2026-05-08T11:00:00+09:00") +
        sessionEndedLine(id, "E0B", "2026-05-08T11:00:30+09:00");
      await placeSession(paths, { id, status: "running" }, events);
      const session = await readSessionYaml(paths, id);
      const r = await classifySuspect(paths, id, session, new Date("2026-05-09T03:00:00Z"));
      expect(r).toEqual({ suspect: true, suspectReason: "events_say_ended_but_yaml_running" });
    });

    it("case 8b: Rule B — running yaml, last event > 24h old", async () => {
      const paths = await setupPaths();
      const id = SES("XA7");
      const events = sessionStartedLine(id, "E0C", "2026-05-07T03:00:00+00:00");
      await placeSession(paths, { id, status: "running" }, events);
      const session = await readSessionYaml(paths, id);
      const r = await classifySuspect(paths, id, session, new Date("2026-05-09T03:00:00Z"));
      expect(r).toEqual({ suspect: true, suspectReason: "running_no_end_event" });
    });

    it("case 8c: healthy completed session is never suspect", async () => {
      const paths = await setupPaths();
      const id = SES("XA8");
      await placeSession(paths, { id, status: "completed" });
      const session = await readSessionYaml(paths, id);
      const r = await classifySuspect(paths, id, session, new Date("2026-05-09T03:00:00Z"));
      expect(r).toEqual({ suspect: false, suspectReason: null });
    });
  });

  describe("loadSessionEntries", () => {
    it("case 7: skips a session whose session.yaml is missing via onSkip", async () => {
      const paths = await setupPaths();
      const healthy = SES("XA9");
      const broken = SES("XAB");
      await placeSession(paths, { id: healthy });
      await mkdir(join(paths.sessions, broken), { recursive: true });
      const skips: Array<{ sid: string; reason: SessionSkipReason }> = [];
      const entries = await loadSessionEntries(paths, {
        now: new Date("2026-05-09T03:00:00Z"),
        onSkip: (sid, reason) => skips.push({ sid, reason }),
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sessionId).toBe(healthy);
      expect(skips).toEqual([{ sid: broken, reason: "session_yaml_missing" }]);
    });

    it("case 9: pushes an entry but flags events_jsonl_unreadable when events.jsonl is unreadable", async () => {
      const paths = await setupPaths();
      const id = SES("XAC");
      await placeSession(paths, { id, status: "running" });
      // Replace events.jsonl with a directory so createReadStream fails with
      // EISDIR. This is more portable than chmod-based EACCES across CI.
      await mkdir(join(paths.sessions, id, "events.jsonl"), { recursive: true });
      const skips: Array<{ sid: string; reason: SessionSkipReason }> = [];
      const entries = await loadSessionEntries(paths, {
        now: new Date("2026-05-09T03:00:00Z"),
        onSkip: (sid, reason) => skips.push({ sid, reason }),
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        sessionId: id,
        suspect: false,
        suspectReason: null,
      });
      expect(skips).toEqual([{ sid: id, reason: "events_jsonl_unreadable" }]);
    });

    it("case 10: skips a session with invalid session.yaml schema and reports session_yaml_invalid", async () => {
      const paths = await setupPaths();
      const id = SES("XAD");
      const sessionDir = join(paths.sessions, id);
      await mkdir(sessionDir, { recursive: true });
      // schema violation: missing required fields
      await writeFile(
        join(sessionDir, "session.yaml"),
        stringify({ schema_version: "0.1.0", session: { id } }),
      );
      const skips: Array<{ sid: string; reason: SessionSkipReason }> = [];
      const entries = await loadSessionEntries(paths, {
        now: new Date("2026-05-09T03:00:00Z"),
        onSkip: (sid, reason) => skips.push({ sid, reason }),
      });
      expect(entries).toHaveLength(0);
      expect(skips).toEqual([{ sid: id, reason: "session_yaml_invalid" }]);
    });
  });
});
