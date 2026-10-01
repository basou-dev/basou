import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { appendChainedEvent } from "../events/chained-append.js";
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
});

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
