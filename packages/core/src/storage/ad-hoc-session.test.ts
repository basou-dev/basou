import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { Event } from "../schemas/event.schema.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import {
  FailedToFinalizeError,
  appendEventToExistingSession,
  createAdHocSessionWithEvent,
} from "./ad-hoc-session.js";
import { type BasouPaths, ensureBasouDirectory } from "./basou-dir.js";
import { linkYamlFile, overwriteYamlFile } from "./yaml-store.js";

vi.mock("./yaml-store.js", async () => {
  const actual = await vi.importActual<typeof import("./yaml-store.js")>("./yaml-store.js");
  return {
    ...actual,
    linkYamlFile: vi.fn(actual.linkYamlFile),
    overwriteYamlFile: vi.fn(actual.overwriteYamlFile),
  };
});

const LOCAL_WS_ID = "ws_01HXABCDEF1234567890ABCWS1" as const;
const VALID_SES_ID = "ses_01HXABCDEF1234567890ABCSE1" as const;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-ad-hoc-session-test-"));
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

function makeManifest(): Manifest {
  return {
    schema_version: "0.1.0",
    basou_version: "0.1.0",
    workspace: {
      id: LOCAL_WS_ID,
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

async function readEventsJsonl(
  paths: BasouPaths,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const body = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
  if (body.length === 0) return [];
  return body
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function readSessionYaml(
  paths: BasouPaths,
  sessionId: string,
): Promise<{ session: Record<string, unknown>; schema_version: string }> {
  const body = await readFile(join(paths.sessions, sessionId, "session.yaml"), "utf8");
  return parse(body) as { session: Record<string, unknown>; schema_version: string };
}

function buildDecisionTargetEvent(
  decisionId: string,
  title: string,
  occurredAt: string,
): (sessionId: string, eventId: string) => Event {
  return (sessionId, eventId) =>
    ({
      schema_version: "0.1.0",
      id: eventId,
      session_id: sessionId,
      occurred_at: occurredAt,
      source: "local-cli",
      type: "decision_recorded",
      decision_id: decisionId,
      title,
    }) as Event;
}

function buildNoteTargetEvent(
  body: string,
  occurredAt: string,
): (sessionId: string, eventId: string) => Event {
  return (sessionId, eventId) =>
    ({
      schema_version: "0.1.0",
      id: eventId,
      session_id: sessionId,
      occurred_at: occurredAt,
      source: "local-cli",
      type: "note_added",
      body,
    }) as Event;
}

describe("createAdHocSessionWithEvent", () => {
  it("creates session.yaml + events.jsonl on the happy path", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";
    const result = await createAdHocSessionWithEvent({
      paths,
      manifest: makeManifest(),
      label: "Ad-hoc decision: choose pnpm",
      occurredAt,
      sessionSource: "human",
      workingDirectory: "/srv/example-project",
      invocation: { command: "basou decision record", args: ["--title", "choose pnpm"] },
      targetEventBuilder: buildDecisionTargetEvent(
        "decision_01HXABCDEF1234567890ABCDE1",
        "choose pnpm",
        occurredAt,
      ),
    });

    expect(result.sessionId.startsWith("ses_")).toBe(true);
    expect(result.targetEventId.startsWith("evt_")).toBe(true);
    expect(result.lifecycleEventIds).toHaveLength(4);
    for (const id of result.lifecycleEventIds) {
      expect(id.startsWith("evt_")).toBe(true);
    }
    expect(result.lifecycleEventIds).not.toContain(result.targetEventId);
  });

  it("writes session.yaml with status completed, ended_at, and invocation.exit_code 0", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";
    const result = await createAdHocSessionWithEvent({
      paths,
      manifest: makeManifest(),
      label: "Ad-hoc decision: x",
      occurredAt,
      sessionSource: "human",
      workingDirectory: "/srv/example-project",
      invocation: { command: "basou decision record", args: ["--title", "x"] },
      targetEventBuilder: buildDecisionTargetEvent(
        "decision_01HXABCDEF1234567890ABCDE2",
        "x",
        occurredAt,
      ),
    });

    const yaml = await readSessionYaml(paths, result.sessionId);
    expect(yaml.schema_version).toBe("0.1.0");
    expect(yaml.session.status).toBe("completed");
    expect(yaml.session.started_at).toBe(occurredAt);
    expect(yaml.session.ended_at).toBe(occurredAt);
    expect(yaml.session.workspace_id).toBe(LOCAL_WS_ID);
    expect(yaml.session.events_log).toBe("events.jsonl");
    expect(yaml.session.label).toBe("Ad-hoc decision: x");
    const invocation = yaml.session.invocation as Record<string, unknown>;
    expect(invocation.command).toBe("basou decision record");
    expect(invocation.args).toEqual(["--title", "x"]);
    expect(invocation.exit_code).toBe(0);
  });

  it("emits the 5-event lifecycle in chronological order", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";
    const result = await createAdHocSessionWithEvent({
      paths,
      manifest: makeManifest(),
      label: "Ad-hoc decision: lifecycle",
      occurredAt,
      sessionSource: "human",
      workingDirectory: "/srv/example-project",
      invocation: { command: "basou decision record", args: [] },
      targetEventBuilder: buildDecisionTargetEvent(
        "decision_01HXABCDEF1234567890ABCDE3",
        "lifecycle",
        occurredAt,
      ),
    });

    const events = await readEventsJsonl(paths, result.sessionId);
    expect(events).toHaveLength(5);
    expect(events[0]?.type).toBe("session_started");
    expect(events[1]?.type).toBe("session_status_changed");
    expect(events[1]).toMatchObject({ from: "initialized", to: "running" });
    expect(events[2]?.type).toBe("decision_recorded");
    expect(events[3]?.type).toBe("session_status_changed");
    expect(events[3]).toMatchObject({ from: "running", to: "completed" });
    expect(events[4]?.type).toBe("session_ended");
    expect(events[4]).toMatchObject({ exit_code: 0 });
  });

  it("records the decision_recorded target event with the supplied decision_id and title", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";
    const decisionId = "decision_01HXABCDEF1234567890ABCDE4";
    const result = await createAdHocSessionWithEvent({
      paths,
      manifest: makeManifest(),
      label: "Ad-hoc decision: keep",
      occurredAt,
      sessionSource: "human",
      workingDirectory: "/srv/example-project",
      invocation: { command: "basou decision record", args: ["--title", "keep"] },
      targetEventBuilder: buildDecisionTargetEvent(decisionId, "keep", occurredAt),
    });

    const events = await readEventsJsonl(paths, result.sessionId);
    const target = events[2];
    expect(target).toMatchObject({
      type: "decision_recorded",
      decision_id: decisionId,
      title: "keep",
      id: result.targetEventId,
    });
  });

  it("records the note_added target event with the supplied body", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";
    const result = await createAdHocSessionWithEvent({
      paths,
      manifest: makeManifest(),
      label: "Ad-hoc note",
      occurredAt,
      sessionSource: "human",
      workingDirectory: "/srv/example-project",
      invocation: { command: "basou session note", args: [] },
      targetEventBuilder: buildNoteTargetEvent("hello note", occurredAt),
    });

    const events = await readEventsJsonl(paths, result.sessionId);
    expect(events[2]).toMatchObject({ type: "note_added", body: "hello note" });
  });

  it("sets session-level source.kind from input and event-level source to local-cli", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";
    const result = await createAdHocSessionWithEvent({
      paths,
      manifest: makeManifest(),
      label: "Ad-hoc decision: source",
      occurredAt,
      sessionSource: "human",
      workingDirectory: "/srv/example-project",
      invocation: { command: "basou decision record", args: [] },
      targetEventBuilder: buildDecisionTargetEvent(
        "decision_01HXABCDEF1234567890ABCDE5",
        "source",
        occurredAt,
      ),
    });

    const yaml = await readSessionYaml(paths, result.sessionId);
    const source = yaml.session.source as Record<string, unknown>;
    expect(source.kind).toBe("human");
    expect(source.version).toBe("0.1.0");

    const events = await readEventsJsonl(paths, result.sessionId);
    for (const event of events) {
      expect(event.source).toBe("local-cli");
    }
  });

  it("shares the same occurred_at across all 5 events", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:34:56+09:00";
    const result = await createAdHocSessionWithEvent({
      paths,
      manifest: makeManifest(),
      label: "Ad-hoc decision: ts",
      occurredAt,
      sessionSource: "human",
      workingDirectory: "/srv/example-project",
      invocation: { command: "basou decision record", args: [] },
      targetEventBuilder: buildDecisionTargetEvent(
        "decision_01HXABCDEF1234567890ABCDE6",
        "ts",
        occurredAt,
      ),
    });
    const events = await readEventsJsonl(paths, result.sessionId);
    for (const event of events) {
      expect(event.occurred_at).toBe(occurredAt);
    }
  });

  it("rejects invalid sessionSource at the core boundary (Y-3s H2)", async () => {
    const paths = await setupPaths();
    await expect(
      createAdHocSessionWithEvent({
        paths,
        manifest: makeManifest(),
        label: "Ad-hoc",
        occurredAt: "2026-05-11T12:00:00+09:00",
        // biome-ignore lint/suspicious/noExplicitAny: testing direct-caller misuse
        sessionSource: "not-a-real-kind" as any,
        workingDirectory: "/srv/example-project",
        invocation: { command: "basou decision record", args: [] },
        targetEventBuilder: buildDecisionTargetEvent(
          "decision_01HXABCDEF1234567890ABCDE7",
          "x",
          "2026-05-11T12:00:00+09:00",
        ),
      }),
    ).rejects.toThrow();
  });

  it("cleans up the session directory when bulk events write fails on invalid payload", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";
    await expect(
      createAdHocSessionWithEvent({
        paths,
        manifest: makeManifest(),
        label: "Ad-hoc",
        occurredAt,
        sessionSource: "human",
        workingDirectory: "/srv/example-project",
        invocation: { command: "basou decision record", args: [] },
        targetEventBuilder: (sessionId, eventId) =>
          ({
            schema_version: "0.1.0",
            id: eventId,
            session_id: sessionId,
            occurred_at: occurredAt,
            source: "local-cli",
            type: "decision_recorded",
            // decision_id missing — fails EventSchema.parse.
            title: "broken",
          }) as unknown as Event,
      }),
    ).rejects.toThrow("Invalid Basou event payload");

    // The rollback should have wiped the partial session directory.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(paths.sessions);
    expect(entries.filter((e) => e.startsWith("ses_"))).toHaveLength(0);
  });

  it("throws FailedToFinalizeError when the final session.yaml overwrite fails", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";

    vi.mocked(overwriteYamlFile).mockImplementationOnce(async () => {
      throw new Error("Failed to overwrite YAML file", {
        cause: Object.assign(new Error("simulated EACCES"), { code: "EACCES" }),
      });
    });

    await expect(
      createAdHocSessionWithEvent({
        paths,
        manifest: makeManifest(),
        label: "Ad-hoc decision: finalize-fail",
        occurredAt,
        sessionSource: "human",
        workingDirectory: "/srv/example-project",
        invocation: { command: "basou decision record", args: [] },
        targetEventBuilder: buildDecisionTargetEvent(
          "decision_01HXABCDEF1234567890ABCDE8",
          "finalize-fail",
          occurredAt,
        ),
      }),
    ).rejects.toThrow(FailedToFinalizeError);
  });

  it("preserves events.jsonl when finalize fails and surfaces sessionId + targetEventId", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";

    vi.mocked(overwriteYamlFile).mockImplementationOnce(async () => {
      throw new Error("Failed to overwrite YAML file", {
        cause: Object.assign(new Error("simulated EACCES"), { code: "EACCES" }),
      });
    });

    let captured: FailedToFinalizeError | undefined;
    try {
      await createAdHocSessionWithEvent({
        paths,
        manifest: makeManifest(),
        label: "Ad-hoc decision: finalize-fail2",
        occurredAt,
        sessionSource: "human",
        workingDirectory: "/srv/example-project",
        invocation: { command: "basou decision record", args: [] },
        targetEventBuilder: buildDecisionTargetEvent(
          "decision_01HXABCDEF1234567890ABCDE9",
          "finalize-fail2",
          occurredAt,
        ),
      });
    } catch (error: unknown) {
      if (error instanceof FailedToFinalizeError) captured = error;
    }

    expect(captured).toBeInstanceOf(FailedToFinalizeError);
    if (captured !== undefined) {
      expect(captured.message).toBe("Failed to finalize ad-hoc session");
      expect(captured.sessionId.startsWith("ses_")).toBe(true);
      expect(captured.targetEventId.startsWith("evt_")).toBe(true);

      const events = await readEventsJsonl(paths, captured.sessionId);
      expect(events).toHaveLength(5);
      const yaml = await readSessionYaml(paths, captured.sessionId);
      expect(yaml.session.status).toBe("initialized");
    }
  });

  it("rejects EEXIST on initial session.yaml write with the collision fixed message", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";

    vi.mocked(linkYamlFile).mockImplementationOnce(async () => {
      throw new Error("Failed to write YAML file", {
        cause: Object.assign(new Error("simulated EEXIST"), { code: "EEXIST" }),
      });
    });

    await expect(
      createAdHocSessionWithEvent({
        paths,
        manifest: makeManifest(),
        label: "Ad-hoc",
        occurredAt,
        sessionSource: "human",
        workingDirectory: "/srv/example-project",
        invocation: { command: "basou decision record", args: [] },
        targetEventBuilder: buildDecisionTargetEvent(
          "decision_01HXABCDEF1234567890ABCDF1",
          "x",
          occurredAt,
        ),
      }),
    ).rejects.toThrow("Session directory collision (retry the command)");
  });

  it("does not leak absolute paths in the bulk-write validation Error message", async () => {
    const paths = await setupPaths();
    const occurredAt = "2026-05-11T12:00:00+09:00";

    let captured: Error | undefined;
    try {
      await createAdHocSessionWithEvent({
        paths,
        manifest: makeManifest(),
        label: "Ad-hoc",
        occurredAt,
        sessionSource: "human",
        workingDirectory: "/srv/example-project",
        invocation: { command: "basou decision record", args: [] },
        targetEventBuilder: (sessionId, eventId) =>
          ({
            schema_version: "0.1.0",
            id: eventId,
            session_id: sessionId,
            occurred_at: occurredAt,
            source: "local-cli",
            type: "decision_recorded",
            title: "no decision_id",
          }) as unknown as Event,
      });
    } catch (error: unknown) {
      if (error instanceof Error) captured = error;
    }
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      expect(captured.message).toBe("Invalid Basou event payload");
      // The cause is the zod error; cause.message intentionally NOT used by
      // the CLI render layer, but the core layer must still hold it.
      expect(captured.cause).toBeDefined();
      expect(captured.message).not.toContain(paths.root);
    }
  });
});

describe("appendEventToExistingSession", () => {
  async function placeSession(
    paths: BasouPaths,
    sessionId: string,
    status:
      | "initialized"
      | "running"
      | "waiting_approval"
      | "completed"
      | "failed"
      | "interrupted"
      | "imported"
      | "archived",
  ): Promise<void> {
    const sessionDir = join(paths.sessions, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await linkYamlFile(join(sessionDir, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: sessionId as `ses_${string}`,
        label: "placed",
        task_id: null,
        workspace_id: LOCAL_WS_ID,
        source: { kind: "human", version: "0.1.0" },
        started_at: "2026-05-11T12:00:00+09:00",
        status,
        working_directory: "/srv/example-project",
        invocation: { command: "test", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
      },
    });
    await writeFile(join(sessionDir, "events.jsonl"), "");
  }

  it("appends a single event to an existing running session without touching session.yaml", async () => {
    const paths = await setupPaths();
    await placeSession(paths, VALID_SES_ID, "running");
    const sessionYamlPath = join(paths.sessions, VALID_SES_ID, "session.yaml");
    const before = await stat(sessionYamlPath);

    const result = await appendEventToExistingSession({
      paths,
      sessionId: VALID_SES_ID,
      eventBuilder: (eventId) =>
        ({
          schema_version: "0.1.0",
          id: eventId,
          session_id: VALID_SES_ID,
          occurred_at: "2026-05-11T12:30:00+09:00",
          source: "local-cli",
          type: "note_added",
          body: "hi",
        }) as Event,
    });

    expect(result.sessionStatus).toBe("running");
    expect(result.eventId.startsWith("evt_")).toBe(true);

    const after = await stat(sessionYamlPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    const events = await readEventsJsonl(paths, VALID_SES_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "note_added", body: "hi" });
  });

  it("accepts waiting_approval as an attachable status", async () => {
    const paths = await setupPaths();
    await placeSession(paths, VALID_SES_ID, "waiting_approval");
    const result = await appendEventToExistingSession({
      paths,
      sessionId: VALID_SES_ID,
      eventBuilder: (eventId) =>
        ({
          schema_version: "0.1.0",
          id: eventId,
          session_id: VALID_SES_ID,
          occurred_at: "2026-05-11T12:30:00+09:00",
          source: "local-cli",
          type: "note_added",
          body: "wa",
        }) as Event,
    });
    expect(result.sessionStatus).toBe("waiting_approval");
  });

  it("rejects a completed session with 'Session is not active: completed'", async () => {
    const paths = await setupPaths();
    await placeSession(paths, VALID_SES_ID, "completed");
    await expect(
      appendEventToExistingSession({
        paths,
        sessionId: VALID_SES_ID,
        eventBuilder: (eventId) =>
          ({
            schema_version: "0.1.0",
            id: eventId,
            session_id: VALID_SES_ID,
            occurred_at: "2026-05-11T12:30:00+09:00",
            source: "local-cli",
            type: "note_added",
            body: "no",
          }) as Event,
      }),
    ).rejects.toThrow("Session is not active: completed");
  });

  it("rejects an imported session with the dedicated message", async () => {
    const paths = await setupPaths();
    await placeSession(paths, VALID_SES_ID, "imported");
    await expect(
      appendEventToExistingSession({
        paths,
        sessionId: VALID_SES_ID,
        eventBuilder: (eventId) =>
          ({
            schema_version: "0.1.0",
            id: eventId,
            session_id: VALID_SES_ID,
            occurred_at: "2026-05-11T12:30:00+09:00",
            source: "local-cli",
            type: "note_added",
            body: "no",
          }) as Event,
      }),
    ).rejects.toThrow("Cannot attach to imported session");
  });

  it("rejects when the session does not exist", async () => {
    const paths = await setupPaths();
    await expect(
      appendEventToExistingSession({
        paths,
        sessionId: VALID_SES_ID,
        eventBuilder: (eventId) =>
          ({
            schema_version: "0.1.0",
            id: eventId,
            session_id: VALID_SES_ID,
            occurred_at: "2026-05-11T12:30:00+09:00",
            source: "local-cli",
            type: "note_added",
            body: "no",
          }) as Event,
      }),
    ).rejects.toThrow();
  });

  it("rejects invalid event payload with 'Invalid Basou event payload'", async () => {
    const paths = await setupPaths();
    await placeSession(paths, VALID_SES_ID, "running");
    await expect(
      appendEventToExistingSession({
        paths,
        sessionId: VALID_SES_ID,
        eventBuilder: (eventId) =>
          ({
            schema_version: "0.1.0",
            id: eventId,
            session_id: VALID_SES_ID,
            occurred_at: "2026-05-11T12:30:00+09:00",
            source: "local-cli",
            type: "note_added",
            // body intentionally omitted
          }) as unknown as Event,
      }),
    ).rejects.toThrow("Invalid Basou event payload");
  });

  it("rejects an invalid sessionId at the core boundary (Y-3s H2)", async () => {
    const paths = await setupPaths();
    await expect(
      appendEventToExistingSession({
        paths,
        // biome-ignore lint/suspicious/noExplicitAny: testing direct-caller misuse
        sessionId: "not-a-ses-id" as any,
        eventBuilder: (eventId) =>
          ({
            schema_version: "0.1.0",
            id: eventId,
            session_id: VALID_SES_ID,
            occurred_at: "2026-05-11T12:30:00+09:00",
            source: "local-cli",
            type: "note_added",
            body: "x",
          }) as Event,
      }),
    ).rejects.toThrow();
  });

  it("rejects a target event whose session_id does not match (Y3s-3-M1)", async () => {
    const paths = await setupPaths();
    await placeSession(paths, VALID_SES_ID, "running");
    const FOREIGN_SES_ID = "ses_01HXFOREIGNSESS1234567890";
    await expect(
      appendEventToExistingSession({
        paths,
        sessionId: VALID_SES_ID,
        eventBuilder: (eventId) =>
          ({
            schema_version: "0.1.0",
            id: eventId,
            // Wrong session_id — the builder lied about which session this
            // event belongs to. The orchestrator must reject before disk.
            session_id: FOREIGN_SES_ID,
            occurred_at: "2026-05-11T12:30:00+09:00",
            source: "local-cli",
            type: "note_added",
            body: "x",
          }) as Event,
      }),
    ).rejects.toThrow("Target event session_id mismatch");

    // Ensure the malformed event never landed in events.jsonl.
    const events = await readEventsJsonl(paths, VALID_SES_ID);
    expect(events).toHaveLength(0);
  });

  it("rejects a target event whose id does not match the minted one (Y3s-3-M1)", async () => {
    const paths = await setupPaths();
    await placeSession(paths, VALID_SES_ID, "running");
    const STOLEN_EVENT_ID = "evt_01HXSTOLENEVENT1234567890";
    await expect(
      appendEventToExistingSession({
        paths,
        sessionId: VALID_SES_ID,
        eventBuilder: () =>
          ({
            schema_version: "0.1.0",
            id: STOLEN_EVENT_ID,
            session_id: VALID_SES_ID,
            occurred_at: "2026-05-11T12:30:00+09:00",
            source: "local-cli",
            type: "note_added",
            body: "x",
          }) as Event,
      }),
    ).rejects.toThrow("Target event id mismatch");
  });
});

describe("writeEventsBulk error contract (Y3s-3-M2)", () => {
  it("surfaces 'Failed to write events.jsonl' without leaking absolute paths in cause.message", async () => {
    const { writeEventsBulk } = await import("../events/event-writer.js");
    // Point at a directory that doesn't exist so the underlying writeFile
    // fails with ENOENT (cannot create tmp file in a missing dir).
    const bogusDir = join(getWorkDir(), "no-such-session-dir");
    let captured: Error | undefined;
    try {
      await writeEventsBulk(bogusDir, [
        {
          schema_version: "0.1.0",
          id: "evt_01HXABCDEF1234567890ABCEV1" as `evt_${string}`,
          session_id: "ses_01HXABCDEF1234567890ABCSE1" as `ses_${string}`,
          occurred_at: "2026-05-11T12:00:00+09:00",
          source: "local-cli",
          type: "session_started",
        },
      ]);
    } catch (error: unknown) {
      if (error instanceof Error) captured = error;
    }
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      expect(captured.message).toBe("Failed to write events.jsonl");
      expect(captured.message).not.toContain(bogusDir);
      expect(captured.cause).toBeDefined();
    }
  });

  it("surfaces 'Invalid Basou event payload' fixed message on validation failure", async () => {
    const paths = await setupPaths();
    const { writeEventsBulk } = await import("../events/event-writer.js");
    let captured: Error | undefined;
    try {
      await writeEventsBulk(paths.sessions, [
        // type=note_added but body missing — EventSchema rejects.
        {
          schema_version: "0.1.0",
          id: "evt_01HXABCDEF1234567890ABCEV2" as `evt_${string}`,
          session_id: "ses_01HXABCDEF1234567890ABCSE2" as `ses_${string}`,
          occurred_at: "2026-05-11T12:00:00+09:00",
          source: "local-cli",
          type: "note_added",
        } as unknown as Event,
      ]);
    } catch (error: unknown) {
      if (error instanceof Error) captured = error;
    }
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      expect(captured.message).toBe("Invalid Basou event payload");
      expect(captured.message).not.toContain(paths.sessions);
      expect(captured.cause).toBeDefined();
    }
  });
});
