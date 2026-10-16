import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { appendChainedEvent } from "../events/chained-append.js";
import { readAllEvents, replayEvents } from "../events/event-replay.js";
import { verifyEventsChain } from "../events/verify.js";
import type { PrefixedId } from "../ids/ulid.js";
import type { Event } from "../schemas/event.schema.js";
import { normalizeSessionTimestamps } from "../schemas/iso-timestamp.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import { type Session, SessionSchema } from "../schemas/session.schema.js";
import type { SessionImportPayload } from "../schemas/session-import.schema.js";
import { appendEventToExistingSession, createAdHocSessionWithEvent } from "./ad-hoc-session.js";
import { type BasouPaths, basouPaths, ensureBasouDirectory } from "./basou-dir.js";
import {
  assertSessionDirSafe,
  assertSessionStoreSafe,
  inspectSessionEntry,
  lstatSessionFile,
  type SessionFileName,
  SessionFileNotAFileError,
  SessionNotADirectoryError,
} from "./session-dir.js";
import {
  importSessionFromJson,
  rechainSessionInPlace,
  reimportPreservingId,
} from "./session-import.js";
import {
  classifySuspect,
  enumerateSessionEntries,
  finalizeSessionYaml,
  loadFederatedSessionEntries,
  loadSessionEntries,
  readSessionYaml,
} from "./sessions.js";
import { createTaskWithEvent } from "./tasks.js";

const WS_ID = "ws_01HXABCDEF1234567890ABCWS1" as const;
// Crockford base32 suffixes (no I/L/O/U), so every id is a valid session id.
const SES = (suffix: string): PrefixedId<"ses"> =>
  `ses_01HXABCDEF1234567890ABC${suffix}` as PrefixedId<"ses">;
const REAL = SES("RE1");
const LINKED = SES("SY1");
const FILE = SES("FX1");
const MISSING = SES("MS1");
const TASK_ID = "task_01HXABCDEF1234567890ABCTK1" as PrefixedId<"task">;

const NOT_A_DIRECTORY = (id: string): string =>
  `Session ${id} is not a directory; a symlink or a file there is not followed`;
const STORE_IS_SYMLINK = ".basou/sessions is a symlink; refusing to operate";
const STORE_IS_FILE = ".basou/sessions exists but is not a directory";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-session-dir-test-"));
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

function makeManifest(): Manifest {
  return {
    schema_version: "0.1.0",
    basou_version: "0.1.0",
    workspace: {
      id: WS_ID,
      name: "test-workspace",
      created_at: "2026-05-01T00:00:00+09:00",
      updated_at: "2026-05-01T00:00:00+09:00",
    },
    project: {},
    capabilities: { enabled: [] },
    approval: { default_risk_level: "low" },
    adapters: { "claude-code": { enabled: false } },
    git: { events_log: "ignore" },
  };
}

type Status = "running" | "imported";

function sessionYaml(id: string, status: Status): string {
  return stringify({
    schema_version: "0.1.0",
    session: {
      id,
      label: `fixture ${id.slice(-3)}`,
      task_id: null,
      workspace_id: WS_ID,
      source:
        status === "imported"
          ? { kind: "claude-code-adapter", version: "0.1.0" }
          : { kind: "terminal", version: "0.1.0" },
      started_at: "2026-05-08T11:00:00+09:00",
      status,
      working_directory: "/tmp/fixture",
      invocation: { command: "echo", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
}

// One unchained `session_started` line, byte-identical to its own JSON
// round-trip, so an imported session holding it is eligible for rechaining.
function startedLine(id: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_started",
    id: "evt_01HXABCDEF1234567890ABCEV1",
    session_id: id,
    occurred_at: "2026-05-08T11:00:00+09:00",
    source: "claude-code-adapter",
  })}\n`;
}

async function writeSession(dir: string, id: string, status: Status): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.yaml"), sessionYaml(id, status));
  await writeFile(join(dir, "events.jsonl"), startedLine(id));
}

/**
 * Place session `id` outside the store and link it in at its name, so a read
 * or write that followed the link would succeed. Returns the outside path.
 */
async function placeLinkedSession(paths: BasouPaths, id: string, status: Status): Promise<string> {
  const outside = join(getWorkDir(), `outside-${id.slice(-3)}`);
  await writeSession(outside, id, status);
  await symlink(outside, join(paths.sessions, id));
  return outside;
}

/** Every file under `dir`, with its bytes, so a test can prove nothing changed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    try {
      out[name] = await readFile(join(dir, name), "utf8");
    } catch {
      out[name] = "<dir>";
    }
  }
  return out;
}

function noteEvent(id: string, eventId: string): Event {
  return {
    schema_version: "0.1.0",
    type: "note_added",
    id: eventId,
    session_id: id,
    occurred_at: "2026-05-08T12:00:00+09:00",
    source: "local-cli",
    body: "note",
  } as Event;
}

function importPayload(id: PrefixedId<"ses">): SessionImportPayload {
  return {
    schema_version: "0.1.0",
    session: {
      id,
      workspace_id: WS_ID,
      source: { kind: "claude-code-adapter", version: "0.1.0" },
      started_at: "2026-05-08T11:00:00+09:00",
      status: "completed",
      working_directory: "/srv/example-project",
      invocation: { command: "claude", args: [], exit_code: 0 },
      related_files: [],
    },
    events: [
      {
        schema_version: "0.1.0",
        type: "session_started",
        id: "evt_01HXABCDEF1234567890ABCEV2",
        session_id: id,
        occurred_at: "2026-05-08T11:00:00+09:00",
        source: "claude-code-adapter",
      },
    ],
  };
}

describe("assertSessionStoreSafe", () => {
  it("passes when .basou/sessions is absent or a directory", async () => {
    await expect(assertSessionStoreSafe(basouPaths(getWorkDir()))).resolves.toBeUndefined();
    const paths = await ensureBasouDirectory(getWorkDir());
    await expect(assertSessionStoreSafe(paths)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a .basou/sessions that is a symlink to a directory",
    async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      const outside = join(getWorkDir(), "outside-store");
      await mkdir(outside);
      await rm(paths.sessions, { recursive: true });
      await symlink(outside, paths.sessions);
      await expect(assertSessionStoreSafe(paths)).rejects.toThrow(STORE_IS_SYMLINK);
    },
  );

  it("refuses a .basou/sessions that is a file", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await rm(paths.sessions, { recursive: true });
    await writeFile(paths.sessions, "");
    await expect(assertSessionStoreSafe(paths)).rejects.toThrow(STORE_IS_FILE);
  });
});

describe.skipIf(process.platform === "win32")("inspectSessionEntry", () => {
  it("classifies an entry without following it", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await writeSession(join(paths.sessions, REAL), REAL, "running");
    await placeLinkedSession(paths, LINKED, "running");
    const dangling = SES("DG1");
    await symlink(join(getWorkDir(), "nowhere"), join(paths.sessions, dangling));
    await writeFile(join(paths.sessions, FILE), "");
    expect(await inspectSessionEntry(paths, REAL)).toBe("directory");
    expect(await inspectSessionEntry(paths, LINKED)).toBe("symlink");
    expect(await inspectSessionEntry(paths, dangling)).toBe("symlink");
    expect(await inspectSessionEntry(paths, FILE)).toBe("not_a_directory");
    expect(await inspectSessionEntry(paths, MISSING)).toBe("missing");
  });

  it("checks the store first", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const outside = join(getWorkDir(), "outside-store");
    await writeSession(join(outside, REAL), REAL, "running");
    await rm(paths.sessions, { recursive: true });
    await symlink(outside, paths.sessions);
    await expect(inspectSessionEntry(paths, REAL)).rejects.toThrow(STORE_IS_SYMLINK);
  });
});

describe.skipIf(process.platform === "win32")("assertSessionDirSafe", () => {
  it("passes a directory and a missing entry, and refuses a symlink or a file", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await writeSession(join(paths.sessions, REAL), REAL, "running");
    await placeLinkedSession(paths, LINKED, "running");
    await writeFile(join(paths.sessions, FILE), "");
    await expect(assertSessionDirSafe(paths, REAL)).resolves.toBeUndefined();
    await expect(assertSessionDirSafe(paths, MISSING)).resolves.toBeUndefined();
    await expect(assertSessionDirSafe(paths, LINKED)).rejects.toThrow(NOT_A_DIRECTORY(LINKED));
    await expect(assertSessionDirSafe(paths, FILE)).rejects.toThrow(NOT_A_DIRECTORY(FILE));
  });

  it("refuses with a SessionNotADirectoryError naming the id and what is there", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await placeLinkedSession(paths, LINKED, "running");
    await writeFile(join(paths.sessions, FILE), "");
    const linked = await assertSessionDirSafe(paths, LINKED).catch((error: unknown) => error);
    expect(linked).toBeInstanceOf(SessionNotADirectoryError);
    expect(linked).toMatchObject({
      name: "SessionNotADirectoryError",
      sessionId: LINKED,
      kind: "symlink",
    });
    const file = await assertSessionDirSafe(paths, FILE).catch((error: unknown) => error);
    expect(file).toBeInstanceOf(SessionNotADirectoryError);
    expect(file).toMatchObject({ sessionId: FILE, kind: "not_a_directory" });
  });
});

/** Drain {@link replayEvents}, keeping what it yielded before any throw. */
async function drain(paths: BasouPaths, id: string): Promise<{ yielded: Event[]; error: unknown }> {
  const yielded: Event[] = [];
  try {
    for await (const ev of replayEvents(paths, id)) yielded.push(ev);
  } catch (error: unknown) {
    return { yielded, error };
  }
  return { yielded, error: undefined };
}

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("a session named by id is not followed", () => {
  it("control: the same fixtures, as directories in the store, are read and written", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const running = SES("CT1");
    const imported = SES("CT2");
    await writeSession(join(paths.sessions, running), running, "running");
    await writeSession(join(paths.sessions, imported), imported, "imported");
    expect((await readSessionYaml(paths, running)).session.status).toBe("running");
    await appendEventToExistingSession({
      paths,
      sessionId: running,
      eventBuilder: (eventId) => noteEvent(running, eventId),
    });
    const lines = (await readFile(join(paths.sessions, running, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(await rechainSessionInPlace(paths, imported)).toEqual({
      status: "rechained",
      eventCount: 1,
    });
  });

  it("the event readers refuse it and read nothing behind it", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await placeLinkedSession(paths, LINKED, "running");
    await writeFile(join(paths.sessions, FILE), startedLine(FILE));
    // A symlink is refused whatever it points to, including where a reader
    // that looked for events.jsonl first would find none and yield nothing.
    const dangling = SES("DG1");
    await symlink(join(getWorkDir(), "nowhere"), join(paths.sessions, dangling));
    const toEmpty = SES("EM1");
    const empty = join(getWorkDir(), "empty-dir");
    await mkdir(empty);
    await symlink(empty, join(paths.sessions, toEmpty));
    for (const [id, kind] of [
      [LINKED, "symlink"],
      [dangling, "symlink"],
      [toEmpty, "symlink"],
      [FILE, "not_a_directory"],
    ] as const) {
      const eager = await readAllEvents(paths, id).catch((error: unknown) => error);
      expect(eager).toBeInstanceOf(SessionNotADirectoryError);
      expect(eager).toMatchObject({ sessionId: id, kind, message: NOT_A_DIRECTORY(id) });
      const streamed = await drain(paths, id);
      expect(streamed.yielded).toEqual([]);
      expect(streamed.error).toBeInstanceOf(SessionNotADirectoryError);
    }
  });

  it("control: the event readers read a session in the store, and nothing for a missing one", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await writeSession(join(paths.sessions, REAL), REAL, "running");
    expect((await readAllEvents(paths, REAL)).map((ev) => ev.session_id)).toEqual([REAL]);
    expect(await drain(paths, REAL)).toMatchObject({ error: undefined });
    expect(await readAllEvents(paths, MISSING)).toEqual([]);
  });

  it("readSessionYaml refuses it", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await placeLinkedSession(paths, LINKED, "running");
    await writeFile(join(paths.sessions, FILE), sessionYaml(FILE, "running"));
    await expect(readSessionYaml(paths, LINKED)).rejects.toThrow(NOT_A_DIRECTORY(LINKED));
    await expect(readSessionYaml(paths, FILE)).rejects.toThrow(NOT_A_DIRECTORY(FILE));
  });

  it("an append, a note, a task attach and a finalize write nothing through it", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const outside = await placeLinkedSession(paths, LINKED, "running");
    const before = await snapshot(outside);
    await expect(
      appendChainedEvent(paths, LINKED, noteEvent(LINKED, "evt_01HXABCDEF1234567890ABCEV3")),
    ).rejects.toThrow(NOT_A_DIRECTORY(LINKED));
    await expect(
      appendEventToExistingSession({
        paths,
        sessionId: LINKED,
        eventBuilder: (eventId) => noteEvent(LINKED, eventId),
      }),
    ).rejects.toThrow(NOT_A_DIRECTORY(LINKED));
    await expect(
      createTaskWithEvent({
        mode: "attach",
        paths,
        occurredAt: "2026-05-08T12:00:00+09:00",
        sessionId: LINKED,
        taskId: TASK_ID,
        title: "attached",
        initialStatus: "planned",
        description: "",
      }),
    ).rejects.toThrow(NOT_A_DIRECTORY(LINKED));
    await expect(
      finalizeSessionYaml(paths, LINKED, (s) => {
        s.session.status = "completed";
      }),
    ).rejects.toThrow(NOT_A_DIRECTORY(LINKED));
    await expect(
      classifySuspect(paths, LINKED, sessionDocument(LINKED, "running"), new Date()),
    ).rejects.toThrow(NOT_A_DIRECTORY(LINKED));
    expect(await snapshot(outside)).toEqual(before);
    expect(await readdir(paths.tasks)).not.toContain(`${TASK_ID}.md`);
  });

  it("rechain skips it as symlink / not_a_directory and rewrites nothing", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const outside = await placeLinkedSession(paths, LINKED, "imported");
    await writeFile(join(paths.sessions, FILE), "");
    const before = await snapshot(outside);
    expect(await rechainSessionInPlace(paths, LINKED)).toEqual({
      status: "skipped",
      reason: "symlink",
    });
    expect(await rechainSessionInPlace(paths, LINKED, { dryRun: true })).toEqual({
      status: "skipped",
      reason: "symlink",
    });
    expect(await rechainSessionInPlace(paths, FILE)).toEqual({
      status: "skipped",
      reason: "not_a_directory",
    });
    expect(await snapshot(outside)).toEqual(before);
  });

  it("an in-place re-import refuses it as a broken prior and rewrites nothing", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const outside = await placeLinkedSession(paths, LINKED, "imported");
    const before = await snapshot(outside);
    expect(
      await reimportPreservingId(paths, makeManifest(), LINKED, importPayload(LINKED)),
    ).toEqual({ status: "skipped", reason: "prior_chain_broken" });
    expect(await snapshot(outside)).toEqual(before);
  });
});

const FILE_NOT_A_FILE = (file: string, id: string): string =>
  `${file} of session ${id} is not a regular file; a symlink or anything else there is not followed`;

type FileSwap = "symlink" | "dangling" | "fifo" | "directory";

/**
 * Replace `file` of session `id` (a directory in the store) with something
 * that is not a regular file. A `symlink` points at an intact copy of the file
 * outside the store, so a reader or writer that followed it would succeed;
 * the copy's path is returned. A `fifo` would block a reader that opened it.
 */
async function swapSessionFile(
  paths: BasouPaths,
  id: string,
  file: SessionFileName,
  how: FileSwap,
): Promise<string> {
  const path = join(paths.sessions, id, file);
  const outside = join(getWorkDir(), `outside-${id.slice(-3)}-${file}`);
  await writeFile(outside, await readFile(path));
  await rm(path);
  if (how === "symlink") await symlink(outside, path);
  else if (how === "dangling") await symlink(join(getWorkDir(), "nowhere"), path);
  else if (how === "fifo") execFileSync("mkfifo", [path]);
  else await mkdir(path);
  return outside;
}

// A Crockford base32 code for each swap, to build valid session ids from.
const CODE: Record<FileSwap, string> = {
  symlink: "SY",
  dangling: "DG",
  fifo: "FF",
  directory: "DR",
};

const SWAPS: [FileSwap, "symlink" | "not_a_file"][] = [
  ["symlink", "symlink"],
  ["dangling", "symlink"],
  ["fifo", "not_a_file"],
  ["directory", "not_a_file"],
];

// POSIX only: symlinks need privileges on Windows, and it has no mkfifo.
describe.skipIf(process.platform === "win32")(
  "a session file that is not a regular file is not followed",
  () => {
    it("lstatSessionFile classifies a session file without following it", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      for (const [how] of SWAPS) {
        const id = SES(`${CODE[how]}1`);
        await writeSession(join(paths.sessions, id), id, "running");
        await swapSessionFile(paths, id, "events.jsonl", how);
      }
      await writeSession(join(paths.sessions, REAL), REAL, "running");
      await rm(join(paths.sessions, REAL, "session.yaml"));
      expect(await lstatSessionFile(paths, REAL, "events.jsonl")).toBe("file");
      expect(await lstatSessionFile(paths, REAL, "session.yaml")).toBe("missing");
      expect(await lstatSessionFile(paths, SES("SY1"), "events.jsonl")).toBe("symlink");
      expect(await lstatSessionFile(paths, SES("DG1"), "events.jsonl")).toBe("symlink");
      expect(await lstatSessionFile(paths, SES("FF1"), "events.jsonl")).toBe("not_a_file");
      expect(await lstatSessionFile(paths, SES("DR1"), "events.jsonl")).toBe("not_a_file");
    });

    it("the event readers refuse an events.jsonl that is not a regular file and read nothing", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      for (const [how, kind] of SWAPS) {
        const id = SES(`${CODE[how]}2`);
        await writeSession(join(paths.sessions, id), id, "running");
        await swapSessionFile(paths, id, "events.jsonl", how);
        const eager = await readAllEvents(paths, id).catch((error: unknown) => error);
        expect(eager).toBeInstanceOf(SessionFileNotAFileError);
        expect(eager).toMatchObject({
          name: "SessionFileNotAFileError",
          sessionId: id,
          file: "events.jsonl",
          kind,
          message: FILE_NOT_A_FILE("events.jsonl", id),
        });
        const streamed = await drain(paths, id);
        expect(streamed.yielded).toEqual([]);
        expect(streamed.error).toBeInstanceOf(SessionFileNotAFileError);
      }
    });

    it("control: the event readers read a regular events.jsonl and nothing for a missing one", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      await writeSession(join(paths.sessions, REAL), REAL, "running");
      expect((await readAllEvents(paths, REAL)).map((ev) => ev.session_id)).toEqual([REAL]);
      await rm(join(paths.sessions, REAL, "events.jsonl"));
      expect(await readAllEvents(paths, REAL)).toEqual([]);
    });

    it("readSessionYaml refuses a session.yaml that is not a regular file", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      for (const [how, kind] of SWAPS) {
        const id = SES(`${CODE[how]}3`);
        await writeSession(join(paths.sessions, id), id, "running");
        await swapSessionFile(paths, id, "session.yaml", how);
        const error = await readSessionYaml(paths, id).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SessionFileNotAFileError);
        expect(error).toMatchObject({
          sessionId: id,
          file: "session.yaml",
          kind,
          message: FILE_NOT_A_FILE("session.yaml", id),
        });
      }
    });

    it("a listing leaves out a session whose session.yaml is not a regular file and keeps one whose events.jsonl is not", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      const yamlLinked = SES("YM1");
      const eventsLinked = SES("EV1");
      await writeSession(join(paths.sessions, REAL), REAL, "running");
      await writeSession(join(paths.sessions, yamlLinked), yamlLinked, "running");
      await writeSession(join(paths.sessions, eventsLinked), eventsLinked, "running");
      await swapSessionFile(paths, yamlLinked, "session.yaml", "symlink");
      await swapSessionFile(paths, eventsLinked, "events.jsonl", "fifo");
      const skips: string[] = [];
      const entries = await loadSessionEntries(paths, {
        now: new Date("2026-05-08T12:00:00+09:00"),
        onSkip: (sid, reason) => skips.push(`${sid}:${reason}`),
      });
      expect(entries.map((e) => e.sessionId)).toEqual([eventsLinked, REAL]);
      expect(skips.sort()).toEqual(
        [`${yamlLinked}:session_yaml_not_a_file`, `${eventsLinked}:events_jsonl_unreadable`].sort(),
      );
    });

    it("an append, a note, a task attach and a finalize write nothing through an events.jsonl that is not a regular file", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      for (const how of ["symlink", "fifo"] as const) {
        const id = SES(`${CODE[how]}4`);
        await writeSession(join(paths.sessions, id), id, "running");
        const outside = await swapSessionFile(paths, id, "events.jsonl", how);
        const before = await readFile(outside, "utf8");
        const refusal = FILE_NOT_A_FILE("events.jsonl", id);
        await expect(
          appendChainedEvent(paths, id, noteEvent(id, "evt_01HXABCDEF1234567890ABCEV6")),
        ).rejects.toThrow(refusal);
        await expect(
          appendEventToExistingSession({
            paths,
            sessionId: id,
            eventBuilder: (eventId) => noteEvent(id, eventId),
          }),
        ).rejects.toThrow(refusal);
        await expect(
          createTaskWithEvent({
            mode: "attach",
            paths,
            occurredAt: "2026-05-08T12:00:00+09:00",
            sessionId: id,
            taskId: TASK_ID,
            title: "attached",
            initialStatus: "planned",
            description: "",
          }),
        ).rejects.toThrow(refusal);
        await expect(
          finalizeSessionYaml(paths, id, (s) => {
            s.session.status = "completed";
          }),
        ).rejects.toThrow(refusal);
        expect(await readFile(outside, "utf8")).toBe(before);
        // The session is left as it was: still running, with no anchor.
        expect((await readSessionYaml(paths, id)).session).toMatchObject({ status: "running" });
        expect((await readSessionYaml(paths, id)).session.integrity).toBeUndefined();
      }
      expect(await readdir(paths.tasks)).not.toContain(`${TASK_ID}.md`);
    });

    it("a note, a task attach and a finalize write nothing through a session.yaml that is not a regular file", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      await writeSession(join(paths.sessions, LINKED), LINKED, "running");
      const outside = await swapSessionFile(paths, LINKED, "session.yaml", "symlink");
      const before = await snapshot(join(paths.sessions, LINKED));
      const outsideBefore = await readFile(outside, "utf8");
      const refusal = FILE_NOT_A_FILE("session.yaml", LINKED);
      await expect(
        appendEventToExistingSession({
          paths,
          sessionId: LINKED,
          eventBuilder: (eventId) => noteEvent(LINKED, eventId),
        }),
      ).rejects.toThrow(refusal);
      await expect(
        createTaskWithEvent({
          mode: "attach",
          paths,
          occurredAt: "2026-05-08T12:00:00+09:00",
          sessionId: LINKED,
          taskId: TASK_ID,
          title: "attached",
          initialStatus: "planned",
          description: "",
        }),
      ).rejects.toThrow(refusal);
      await expect(
        finalizeSessionYaml(paths, LINKED, (s) => {
          s.session.status = "completed";
        }),
      ).rejects.toThrow(refusal);
      expect(await readFile(outside, "utf8")).toBe(outsideBefore);
      expect(await snapshot(join(paths.sessions, LINKED))).toEqual(before);
      expect(await readdir(paths.tasks)).not.toContain(`${TASK_ID}.md`);
    });

    it("rechain skips it as events_not_a_file / yaml_not_a_file and rewrites nothing", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      const eventsLinked = SES("EV5");
      const yamlLinked = SES("YM5");
      await writeSession(join(paths.sessions, eventsLinked), eventsLinked, "imported");
      await writeSession(join(paths.sessions, yamlLinked), yamlLinked, "imported");
      const outsideEvents = await swapSessionFile(paths, eventsLinked, "events.jsonl", "symlink");
      const outsideYaml = await swapSessionFile(paths, yamlLinked, "session.yaml", "symlink");
      const before = [await readFile(outsideEvents, "utf8"), await readFile(outsideYaml, "utf8")];
      for (const dryRun of [true, false]) {
        expect(await rechainSessionInPlace(paths, eventsLinked, { dryRun })).toEqual({
          status: "skipped",
          reason: "events_not_a_file",
        });
        expect(await rechainSessionInPlace(paths, yamlLinked, { dryRun })).toEqual({
          status: "skipped",
          reason: "yaml_not_a_file",
        });
      }
      expect([await readFile(outsideEvents, "utf8"), await readFile(outsideYaml, "utf8")]).toEqual(
        before,
      );
      // The same sessions with their files back in place are rechained.
      for (const [id, file, outside] of [
        [eventsLinked, "events.jsonl", outsideEvents],
        [yamlLinked, "session.yaml", outsideYaml],
      ] as const) {
        await rm(join(paths.sessions, id, file));
        await writeFile(join(paths.sessions, id, file), await readFile(outside));
        expect(await rechainSessionInPlace(paths, id)).toEqual({
          status: "rechained",
          eventCount: 1,
        });
      }
    });

    it("an in-place re-import refuses it as a broken prior and rewrites nothing", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      for (const file of ["events.jsonl", "session.yaml"] as const) {
        const id = SES(file === "events.jsonl" ? "EV6" : "YM6");
        await writeSession(join(paths.sessions, id), id, "imported");
        const outside = await swapSessionFile(paths, id, file, "symlink");
        const before = await readFile(outside, "utf8");
        expect(await reimportPreservingId(paths, makeManifest(), id, importPayload(id))).toEqual({
          status: "skipped",
          reason: "prior_chain_broken",
        });
        expect(await readFile(outside, "utf8")).toBe(before);
        expect(await lstatSessionFile(paths, id, file)).toBe("symlink");
      }
    });

    it("classifySuspect refuses a running session whose events.jsonl is a FIFO without blocking", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      await writeSession(join(paths.sessions, REAL), REAL, "running");
      await swapSessionFile(paths, REAL, "events.jsonl", "fifo");
      await expect(
        classifySuspect(paths, REAL, sessionDocument(REAL, "running"), new Date()),
      ).rejects.toThrow(FILE_NOT_A_FILE("events.jsonl", REAL));
    });
  },
);

/** The fixture's session document, as a reader would return it. */
function sessionDocument(id: string, status: Status): Session {
  return SessionSchema.parse(normalizeSessionTimestamps(parse(sessionYaml(id, status))));
}

describe.skipIf(process.platform === "win32")("a .basou/sessions that is a symlink", () => {
  async function linkStore(): Promise<{ paths: BasouPaths; outside: string }> {
    const paths = await ensureBasouDirectory(getWorkDir());
    const outside = join(getWorkDir(), "outside-store");
    await writeSession(join(outside, REAL), REAL, "running");
    await writeSession(join(outside, LINKED), LINKED, "imported");
    await rm(paths.sessions, { recursive: true });
    await symlink(outside, paths.sessions);
    return { paths, outside };
  }

  it("stops every listing, read and verify", async () => {
    const { paths } = await linkStore();
    await expect(enumerateSessionEntries(paths)).rejects.toThrow(STORE_IS_SYMLINK);
    await expect(loadSessionEntries(paths, { now: new Date() })).rejects.toThrow(STORE_IS_SYMLINK);
    await expect(readSessionYaml(paths, REAL)).rejects.toThrow(STORE_IS_SYMLINK);
    await expect(verifyEventsChain(paths, REAL)).rejects.toThrow(STORE_IS_SYMLINK);
  });

  it("writes nothing through it: an append, a rechain, an import or an ad-hoc session", async () => {
    const { paths, outside } = await linkStore();
    const before = await snapshot(outside);
    await expect(
      appendChainedEvent(paths, REAL, noteEvent(REAL, "evt_01HXABCDEF1234567890ABCEV4")),
    ).rejects.toThrow(STORE_IS_SYMLINK);
    await expect(rechainSessionInPlace(paths, LINKED)).rejects.toThrow(STORE_IS_SYMLINK);
    await expect(
      importSessionFromJson(paths, makeManifest(), importPayload(SES("NW1")), {
        dryRun: false,
      }),
    ).rejects.toThrow(STORE_IS_SYMLINK);
    await expect(
      createAdHocSessionWithEvent({
        paths,
        manifest: makeManifest(),
        label: "Ad-hoc note",
        occurredAt: "2026-05-08T12:00:00+09:00",
        sessionSource: "human",
        workingDirectory: "/srv/example-project",
        invocation: { command: "basou note", args: [] },
        targetEventBuilders: [(sessionId, eventId) => noteEvent(sessionId, eventId)],
      }),
    ).rejects.toThrow(STORE_IS_SYMLINK);
    expect(await snapshot(outside)).toEqual(before);
  });
});

describe("a name that is not a session id", () => {
  it("is refused before anything is looked at", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    // A readable session one level up: joining the name would reach it.
    const escaped = join(paths.sessions, "..", "x");
    await writeSession(escaped, REAL, "running");
    await writeSession(join(paths.sessions, `${REAL}.bak`), REAL, "running");
    for (const name of ["../x", `${REAL}.bak`, ""]) {
      await expect(inspectSessionEntry(paths, name)).rejects.toThrow("Invalid session id");
      await expect(assertSessionDirSafe(paths, name)).rejects.toThrow("Invalid session id");
      await expect(readSessionYaml(paths, name)).rejects.toThrow("Invalid session id");
      await expect(readAllEvents(paths, name)).rejects.toThrow("Invalid session id");
    }
  });
});

describe("a name that is not a session id, more closely", () => {
  it.skipIf(process.platform === "win32")("is refused before the store is looked at", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const outside = join(getWorkDir(), "outside-store");
    await mkdir(outside);
    await rm(paths.sessions, { recursive: true });
    await symlink(outside, paths.sessions);
    // The store is a symlink too, but the name is checked first.
    await expect(inspectSessionEntry(paths, "../x")).rejects.toThrow("Invalid session id");
    await expect(readSessionYaml(paths, "../x")).rejects.toThrow("Invalid session id");
  });

  it("is the exact session id shape, not just ses_ and 26 characters", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    // 26 uppercase characters after ses_, but the first is above 7, or one is
    // outside Crockford base32 (L). Each is a readable session on disk.
    const firstAboveSeven = `ses_8${REAL.slice(5)}`;
    const withL = `${REAL.slice(0, -1)}L`;
    for (const name of [firstAboveSeven, withL]) {
      await writeSession(join(paths.sessions, name), name, "running");
      await expect(readSessionYaml(paths, name)).rejects.toThrow("Invalid session id");
    }
  });

  it("takes no session lock: a lockfile path is never built from it", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    // A stale-looking .lock outside the store, where the name would point.
    const victim = join(getWorkDir(), "outside", "victim.lock");
    await mkdir(join(getWorkDir(), "outside"));
    await writeFile(victim, "not a lock");
    const name = "ses_../../../../outside/victim";
    await expect(
      appendChainedEvent(paths, name, noteEvent(REAL, "evt_01HXABCDEF1234567890ABCEV5")),
    ).rejects.toThrow("Invalid session id");
    await expect(finalizeSessionYaml(paths, "../x", () => undefined)).rejects.toThrow(
      "Invalid session id",
    );
    expect(await readFile(victim, "utf8")).toBe("not a lock");
    expect(await readdir(paths.locks).catch(() => [])).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("a federated mirror", () => {
  async function mirrorWithLinkedStore(): Promise<BasouPaths> {
    const mirror = basouPaths(join(getWorkDir(), "mirror"));
    const realStore = join(getWorkDir(), "mirror-store");
    await writeSession(join(realStore, REAL), REAL, "running");
    await mkdir(mirror.root, { recursive: true });
    await symlink(realStore, mirror.sessions);
    return mirror;
  }

  it("is read when its .basou/sessions is a symlink; its own entries still are not followed", async () => {
    const local = await ensureBasouDirectory(getWorkDir());
    const mirror = await mirrorWithLinkedStore();
    await placeLinkedSession(mirror, LINKED, "running");
    const unavailable: string[] = [];
    const skips: string[] = [];
    const entries = await loadFederatedSessionEntries(
      [
        { paths: local, host: null },
        { paths: mirror, host: "laptop" },
      ],
      {
        now: new Date("2026-05-08T12:00:00+09:00"),
        onRootUnavailable: (host) => unavailable.push(host),
        onSkip: (sid, reason) => skips.push(`${sid}:${reason}`),
      },
    );
    expect(entries.map((e) => [e.sessionId, e.host])).toEqual([[REAL, "laptop"]]);
    expect(unavailable).toEqual([]);
    expect(skips).toEqual([`${LINKED}:session_dir_not_directory`]);
  });

  it("is read by the event readers when its .basou/sessions is a symlink; its own entries still are not followed", async () => {
    const mirror = await mirrorWithLinkedStore();
    await placeLinkedSession(mirror, LINKED, "running");
    expect((await readAllEvents(mirror, REAL)).map((ev) => ev.session_id)).toEqual([REAL]);
    const linked = await readAllEvents(mirror, LINKED).catch((error: unknown) => error);
    expect(linked).toBeInstanceOf(SessionNotADirectoryError);
    expect(linked).toMatchObject({ sessionId: LINKED, kind: "symlink" });
  });

  it("does not lift the check from the local store", async () => {
    const local = await ensureBasouDirectory(getWorkDir());
    const outside = join(getWorkDir(), "outside-store");
    await writeSession(join(outside, MISSING), MISSING, "running");
    await rm(local.sessions, { recursive: true });
    await symlink(outside, local.sessions);
    const mirror = await mirrorWithLinkedStore();
    await expect(
      loadFederatedSessionEntries(
        [
          { paths: local, host: null },
          { paths: mirror, host: "laptop" },
        ],
        { now: new Date() },
      ),
    ).rejects.toThrow(STORE_IS_SYMLINK);
  });
});
