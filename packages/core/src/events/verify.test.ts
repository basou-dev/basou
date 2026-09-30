import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Event } from "../schemas/event.schema.js";
import {
  SESSION_SCHEMA_VERSION,
  type Session,
  type SessionIntegrity,
  SessionIntegritySchema,
  SessionStatusSchema,
} from "../schemas/session.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { chainEvents, genesisHash, lineHash } from "./chain.js";
import { verifyEventsChain } from "./verify.js";

const SES_ID = "ses_01HXABCDEF1234567890ABCSE1";
const OTHER_SES_ID = "ses_01HXABCDEF1234567890ABCSE2";
const WS_ID = "ws_01HXABCDEF1234567890ABCWS1";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-verify-test-"));
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

function makeEvent(sessionId: string, suffix: string): Event {
  return {
    schema_version: "0.1.0",
    id: `evt_01HXABCDEF1234567890ABCE${suffix}`,
    session_id: sessionId,
    occurred_at: "2026-05-04T09:00:00+09:00",
    source: "codex-import",
    type: "note_added",
    body: `note ${suffix}`,
  } as Event;
}

function makeSessionRecord(sessionId: string, integrity?: SessionIntegrity): Session {
  return {
    schema_version: "0.1.0",
    session: {
      id: sessionId as Session["session"]["id"],
      task_id: null,
      workspace_id: WS_ID as Session["session"]["workspace_id"],
      source: { kind: "codex-import", version: "0.1.0" },
      started_at: "2026-05-04T09:00:00+09:00",
      status: "imported",
      working_directory: "~/projects/example",
      invocation: { command: "codex", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
      summary: null,
      ...(integrity !== undefined ? { integrity } : {}),
    },
  };
}

type SessionFixture = {
  sessionDir: string;
  eventsPath: string;
  yamlPath: string;
  lines: string[];
  headHash: string;
  count: number;
};

/** Write a chained session dir: chained events.jsonl + anchored session.yaml. */
async function writeChainedSession(
  paths: BasouPaths,
  sessionId: string,
  eventCount: number,
  options: { anchor?: boolean | SessionIntegrity; yaml?: boolean } = {},
): Promise<SessionFixture> {
  const sessionDir = join(paths.sessions, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const suffixes = ["V1", "V2", "V3", "V4", "V5"];
  const events = suffixes.slice(0, eventCount).map((s) => makeEvent(sessionId, s));
  const { lines, headHash, count } = chainEvents(events, sessionId);
  const eventsPath = join(sessionDir, "events.jsonl");
  await writeFile(eventsPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");

  const yamlPath = join(sessionDir, "session.yaml");
  if (options.yaml !== false) {
    const integrity =
      options.anchor === false
        ? undefined
        : typeof options.anchor === "object"
          ? options.anchor
          : { head_hash: headHash, event_count: count };
    await writeFile(yamlPath, stringifyYaml(makeSessionRecord(sessionId, integrity)));
  }
  return { sessionDir, eventsPath, yamlPath, lines, headHash, count };
}

async function rewriteLines(fixture: SessionFixture, lines: string[]): Promise<void> {
  await writeFile(fixture.eventsPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

describe("verifyEventsChain — clean states", () => {
  it("verifies an intact chained session", async () => {
    const paths = await setupPaths();
    await writeChainedSession(paths, SES_ID, 3);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "verified", eventCount: 3 });
  });

  it("reports an unchained session (no prev_hash, no anchor) as unchained", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2, { anchor: false });
    const unchained = fixture.lines.map((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>;
      delete obj.prev_hash;
      return JSON.stringify(obj);
    });
    await rewriteLines(fixture, unchained);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unchained", eventCount: 2 });
  });

  it("reports a zero-byte log without an anchor as empty", async () => {
    const paths = await setupPaths();
    await writeChainedSession(paths, SES_ID, 0, { anchor: false });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "empty", eventCount: 0 });
  });

  it("reports a missing events.jsonl without an anchor as empty", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 0, { anchor: false });
    await rm(fixture.eventsPath, { force: true });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "empty", eventCount: 0 });
  });

  it("reports a chained log whose session.yaml is entirely absent as incomplete", async () => {
    const paths = await setupPaths();
    await writeChainedSession(paths, SES_ID, 2, { yaml: false });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "incomplete", eventCount: 2, reason: "yaml_missing" });
  });
});

describe("verifyEventsChain — event tampering", () => {
  it("detects a byte flip in a middle line (broken_link on the next line)", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    const lines = [...fixture.lines];
    lines[1] = (lines[1] as string).replace("note V2", "note v2");
    await rewriteLines(fixture, lines);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("broken_link");
    expect(verdict.line).toBe(3);
  });

  it("detects a byte flip in the LAST line via the head anchor", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    const lines = [...fixture.lines];
    lines[2] = (lines[2] as string).replace("note V3", "note v3");
    await rewriteLines(fixture, lines);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_mismatch");
  });

  it("detects a mid-chain insertion", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    const lines = [...fixture.lines];
    lines.splice(1, 0, lines[0] as string); // duplicate line 1 in between
    await rewriteLines(fixture, lines);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("broken_link");
    expect(verdict.line).toBe(2);
  });

  it("detects a deleted middle line", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    const lines = [...fixture.lines];
    lines.splice(1, 1);
    await rewriteLines(fixture, lines);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("broken_link");
    expect(verdict.line).toBe(2);
  });

  it("detects reordered lines", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    const lines = [
      fixture.lines[1] as string,
      fixture.lines[0] as string,
      fixture.lines[2] as string,
    ];
    await rewriteLines(fixture, lines);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("genesis_mismatch");
    expect(verdict.line).toBe(1);
  });

  it("detects a tail truncation via the head anchor", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    await rewriteLines(fixture, fixture.lines.slice(0, 2));
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_mismatch");
  });

  it("detects a torn (unterminated) tail", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    await writeFile(fixture.eventsPath, fixture.lines.join("\n")); // no trailing \n
    const verdict = await verifyEventsChain(paths, SES_ID);
    // The unterminated tail is not counted, and `line` is the number it would
    // have (docs/spec/schemas.md §7.5).
    expect(verdict).toEqual({ status: "tampered", eventCount: 2, reason: "torn_tail", line: 3 });
  });

  it("detects a blank line inside a chained log", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    const lines = [fixture.lines[0] as string, "", fixture.lines[1] as string];
    await rewriteLines(fixture, lines);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("blank_line");
    expect(verdict.line).toBe(2);
  });

  it("detects a malformed JSON line inside a chained log", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    const lines = ["{not json", fixture.lines[1] as string];
    await rewriteLines(fixture, lines);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("malformed_line");
    expect(verdict.line).toBe(1);
  });

  it("detects a chained line without prev_hash", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    const second = JSON.parse(fixture.lines[1] as string) as Record<string, unknown>;
    delete second.prev_hash;
    await rewriteLines(fixture, [fixture.lines[0] as string, JSON.stringify(second)]);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("missing_prev_hash");
    expect(verdict.line).toBe(2);
  });

  it("reports a chained line that is valid JSON but not an object as missing_prev_hash", async () => {
    const paths = await setupPaths();
    for (const second of ["null", "1", '"x"', "[]", "true"]) {
      const fixture = await writeChainedSession(paths, SES_ID, 3);
      await rewriteLines(fixture, [fixture.lines[0] as string, second, fixture.lines[2] as string]);
      const verdict = await verifyEventsChain(paths, SES_ID);
      expect({ second, verdict }).toEqual({
        second,
        verdict: { status: "tampered", eventCount: 3, reason: "missing_prev_hash", line: 2 },
      });
    }
  });

  it("detects an invalid-UTF-8 byte substitution that decodes to the same string", async () => {
    const paths = await setupPaths();
    const sessionDir = join(paths.sessions, SES_ID);
    await mkdir(sessionDir, { recursive: true });
    // The middle event's body contains a LEGAL U+FFFD; on disk that is the
    // UTF-8 sequence EF BF BD. Replacing those bytes with the single invalid
    // byte FF decodes back to the same string, so a string-level verifier
    // would re-hash identical content and still pass. Byte-level hashing
    // must flag it.
    const events = [
      makeEvent(SES_ID, "V1"),
      { ...makeEvent(SES_ID, "V2"), body: "marker:�" } as Event,
      makeEvent(SES_ID, "V3"),
    ];
    const { lines, headHash, count } = chainEvents(events, SES_ID);
    const eventsPath = join(sessionDir, "events.jsonl");
    await writeFile(eventsPath, `${lines.join("\n")}\n`);
    await writeFile(
      join(sessionDir, "session.yaml"),
      stringifyYaml(makeSessionRecord(SES_ID, { head_hash: headHash, event_count: count })),
    );
    expect(await verifyEventsChain(paths, SES_ID)).toEqual({ status: "verified", eventCount: 3 });

    const original = await readFile(eventsPath);
    const replacement = Buffer.from([0xff]);
    const needle = Buffer.from([0xef, 0xbf, 0xbd]);
    const at = original.indexOf(needle);
    expect(at).toBeGreaterThan(-1);
    const mutated = Buffer.concat([
      original.subarray(0, at),
      replacement,
      original.subarray(at + needle.length),
    ]);
    // Sanity: the mutation is invisible at the decoded-string level.
    expect(mutated.toString("utf8")).toBe(original.toString("utf8"));
    await writeFile(eventsPath, mutated);

    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("broken_link");
    expect(verdict.line).toBe(3);
  });

  it("rejects a chain copied verbatim from another session (genesis binding)", async () => {
    const paths = await setupPaths();
    const donor = await writeChainedSession(paths, OTHER_SES_ID, 2);
    const target = await writeChainedSession(paths, SES_ID, 2);
    // Copy the donor's internally-consistent log AND its matching anchor.
    await writeFile(target.eventsPath, await readFile(donor.eventsPath));
    await writeFile(
      target.yamlPath,
      stringifyYaml(
        makeSessionRecord(SES_ID, { head_hash: donor.headHash, event_count: donor.count }),
      ),
    );
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("genesis_mismatch");
    expect(verdict.line).toBe(1);
  });

  it("rejects a line whose session_id is not the session's (chained for the right id)", async () => {
    const paths = await setupPaths();
    const sessionDir = join(paths.sessions, SES_ID);
    await mkdir(sessionDir, { recursive: true });
    // Chain FOR SES_ID (correct genesis) but with an event carrying a foreign session_id.
    const { lines, headHash, count } = chainEvents([makeEvent(OTHER_SES_ID, "V1")], SES_ID);
    await writeFile(join(sessionDir, "events.jsonl"), `${lines.join("\n")}\n`);
    await writeFile(
      join(sessionDir, "session.yaml"),
      stringifyYaml(makeSessionRecord(SES_ID, { head_hash: headHash, event_count: count })),
    );
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("session_id_mismatch");
    expect(verdict.line).toBe(1);
  });
});

describe("verifyEventsChain — anchor tampering", () => {
  it("flags a present session.yaml whose integrity anchor was stripped", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await writeFile(fixture.yamlPath, stringifyYaml(makeSessionRecord(SES_ID)));
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_missing");
  });

  it("flags an anchor whose event_count disagrees", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await writeFile(
      fixture.yamlPath,
      stringifyYaml(makeSessionRecord(SES_ID, { head_hash: fixture.headHash, event_count: 5 })),
    );
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_mismatch");
  });

  it("flags an unreadable session.yaml on a chained log", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await writeFile(fixture.yamlPath, "schema_version: [unclosed\n");
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("yaml_unreadable");
    expect(verdict.sessionYamlInvalid).toBe(true);
  });

  it("flags a chain stripped out from under an anchor (anchor_without_chain)", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    const unchained = fixture.lines.map((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>;
      delete obj.prev_hash;
      return JSON.stringify(obj);
    });
    await rewriteLines(fixture, unchained);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_without_chain");
  });

  it("flags a log truncated to zero bytes under an anchor (anchor_without_chain)", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await writeFile(fixture.eventsPath, "");
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_without_chain");
  });

  it("flags a deleted log under an anchor (anchor_without_chain)", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await rm(fixture.eventsPath, { force: true });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_without_chain");
  });
});

// Write a chained session.yaml carrying an arbitrary status (the shared
// makeSessionRecord hardcodes "imported"). Used for the live / strict matrix.
async function writeChainedSessionWithStatus(
  paths: BasouPaths,
  sessionId: string,
  status: Session["session"]["status"],
  options: { anchor?: boolean; count?: number } = {},
): Promise<SessionFixture> {
  const count = options.count ?? 3;
  const fixture = await writeChainedSession(paths, sessionId, count, {
    anchor: options.anchor ?? true,
  });
  const record = makeSessionRecord(
    sessionId,
    options.anchor === false
      ? undefined
      : { head_hash: fixture.headHash, event_count: fixture.count },
  );
  record.session.status = status;
  await writeFile(fixture.yamlPath, stringifyYaml(record));
  return fixture;
}

describe("verifyEventsChain — live (in_progress) verdicts", () => {
  it("reports a running chained session with no anchor as in_progress", async () => {
    const paths = await setupPaths();
    await writeChainedSessionWithStatus(paths, SES_ID, "running", { anchor: false });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "in_progress", eventCount: 3 });
  });

  it("reports a running chained session with a torn tail as in_progress (crashed append)", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSessionWithStatus(paths, SES_ID, "running", {
      anchor: false,
    });
    // Drop the trailing newline => torn tail.
    await writeFile(fixture.eventsPath, fixture.lines.join("\n"));
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("in_progress");
  });

  it("forgives a lagging anchor on a running session (in_progress, not anchor_mismatch)", async () => {
    const paths = await setupPaths();
    // anchor present but for fewer events than on disk (a stale running anchor).
    const fixture = await writeChainedSession(paths, SES_ID, 3, {
      anchor: { head_hash: "stale", event_count: 1 },
    });
    const record = makeSessionRecord(SES_ID, { head_hash: "stale", event_count: 1 });
    record.session.status = "running";
    await writeFile(fixture.yamlPath, stringifyYaml(record));
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("in_progress");
  });

  it("still flags an internal chain break on a running session as tampered", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSessionWithStatus(paths, SES_ID, "running", {
      anchor: false,
    });
    const lines = [...fixture.lines];
    lines[1] = (lines[1] as string).replace("note V2", "note v2");
    await writeFile(fixture.eventsPath, `${lines.join("\n")}\n`);
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("broken_link");
  });

  it("verifies a chained completed (finalized live) session against its anchor", async () => {
    const paths = await setupPaths();
    await writeChainedSessionWithStatus(paths, SES_ID, "completed");
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "verified", eventCount: 3 });
  });

  it("treats archived as strict: a chained archived session with no anchor is tampered", async () => {
    const paths = await setupPaths();
    await writeChainedSessionWithStatus(paths, SES_ID, "archived", { anchor: false });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_missing");
  });
});

// Rewrite a fixture's session.yaml through a mutator applied to the parsed
// record, so a single field can be made to fail validation.
async function mutateSessionYaml(
  fixture: SessionFixture,
  mutate: (inner: Record<string, unknown>) => void,
): Promise<void> {
  const record = parseYaml(await readFile(fixture.yamlPath, "utf8")) as {
    session: Record<string, unknown>;
  };
  mutate(record.session);
  await writeFile(fixture.yamlPath, stringifyYaml(record));
}

describe("verifyEventsChain — session.yaml invalid outside the anchor and status", () => {
  it("verifies an intact log when another field fails validation, and flags the document", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    await mutateSessionYaml(fixture, (inner) => {
      (inner.source as Record<string, unknown>).version = "0.2.0";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "verified", eventCount: 3, sessionYamlInvalid: true });
  });

  it("still reports a real break under an invalid document, with the flag", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3, {
      anchor: { head_hash: "0".repeat(64), event_count: 3 },
    });
    await mutateSessionYaml(fixture, (inner) => {
      inner.working_directory = "";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({
      status: "tampered",
      eventCount: 3,
      reason: "anchor_mismatch",
      sessionYamlInvalid: true,
    });
  });

  it("still reports a stripped anchor under an invalid document as anchor_missing", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2, { anchor: false });
    await mutateSessionYaml(fixture, (inner) => {
      inner.started_at = "not a timestamp";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_missing");
    expect(verdict.sessionYamlInvalid).toBe(true);
  });

  it("forgives a live session's missing anchor under an invalid document (in_progress)", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSessionWithStatus(paths, SES_ID, "running", {
      anchor: false,
    });
    await mutateSessionYaml(fixture, (inner) => {
      inner.invocation = { command: "" };
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "in_progress", eventCount: 3, sessionYamlInvalid: true });
  });

  it("flags an invalid document beside an unchained verdict", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2, { anchor: false });
    await rewriteLines(
      fixture,
      fixture.lines.map((l) => {
        const obj = JSON.parse(l) as Record<string, unknown>;
        delete obj.prev_hash;
        return JSON.stringify(obj);
      }),
    );
    await mutateSessionYaml(fixture, (inner) => {
      delete inner.workspace_id;
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unchained", eventCount: 2, sessionYamlInvalid: true });
  });

  it("reads an anchor left under a stripped chain even when another field fails validation", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await rewriteLines(
      fixture,
      fixture.lines.map((l) => {
        const obj = JSON.parse(l) as Record<string, unknown>;
        delete obj.prev_hash;
        return JSON.stringify(obj);
      }),
    );
    await mutateSessionYaml(fixture, (inner) => {
      delete inner.workspace_id;
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({
      status: "tampered",
      eventCount: 2,
      reason: "anchor_without_chain",
      sessionYamlInvalid: true,
    });
  });

  it("leaves the flag off a valid document, including one whose timestamps lack seconds", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    await mutateSessionYaml(fixture, (inner) => {
      inner.started_at = "2026-05-04T09:00+09:00";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "verified", eventCount: 3 });
    expect(verdict).not.toHaveProperty("sessionYamlInvalid");
  });

  it("reports an anchor that fails its own schema as yaml_unreadable", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await mutateSessionYaml(fixture, (inner) => {
      inner.integrity = { head_hash: fixture.headHash, event_count: "2" };
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({
      status: "tampered",
      eventCount: 2,
      reason: "yaml_unreadable",
      sessionYamlInvalid: true,
    });
  });

  it("reports a null anchor as yaml_unreadable, not as a stripped one", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await mutateSessionYaml(fixture, (inner) => {
      inner.integrity = null;
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({
      status: "tampered",
      eventCount: 2,
      reason: "yaml_unreadable",
      sessionYamlInvalid: true,
    });
  });

  it("reports a status outside the enum as yaml_unreadable", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await mutateSessionYaml(fixture, (inner) => {
      inner.status = "paused";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({
      status: "tampered",
      eventCount: 2,
      reason: "yaml_unreadable",
      sessionYamlInvalid: true,
    });
  });

  it("reports a schema_version that is not a version as yaml_unreadable", async () => {
    const paths = await setupPaths();
    for (const version of ["banana", "0.2", 2]) {
      const fixture = await writeChainedSession(paths, SES_ID, 2);
      const record = parseYaml(await readFile(fixture.yamlPath, "utf8")) as Record<string, unknown>;
      record.schema_version = version;
      await writeFile(fixture.yamlPath, stringifyYaml(record));
      const verdict = await verifyEventsChain(paths, SES_ID);
      expect(verdict).toEqual({
        status: "tampered",
        eventCount: 2,
        reason: "yaml_unreadable",
        sessionYamlInvalid: true,
      });
    }
  });

  it("flags an unparseable session.yaml beside an unchained verdict", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2, { anchor: false });
    await rewriteLines(
      fixture,
      fixture.lines.map((l) => {
        const obj = JSON.parse(l) as Record<string, unknown>;
        delete obj.prev_hash;
        return JSON.stringify(obj);
      }),
    );
    await writeFile(fixture.yamlPath, "schema_version: [unclosed\n");
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unchained", eventCount: 2, sessionYamlInvalid: true });
  });

  // POSIX only: chmod 0o000 has no effect under root.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws on a session.yaml it cannot read (EACCES) instead of judging it",
    async () => {
      const paths = await setupPaths();
      const fixture = await writeChainedSession(paths, SES_ID, 2);
      await chmod(fixture.yamlPath, 0o000);
      try {
        await expect(verifyEventsChain(paths, SES_ID)).rejects.toThrow(
          `Failed to read session.yaml of ${SES_ID}`,
        );
      } finally {
        await chmod(fixture.yamlPath, 0o644);
      }
    },
  );

  it("does not flag an absent session.yaml (incomplete)", async () => {
    const paths = await setupPaths();
    await writeChainedSession(paths, SES_ID, 2, { yaml: false });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "incomplete", eventCount: 2, reason: "yaml_missing" });
    expect(verdict).not.toHaveProperty("sessionYamlInvalid");
  });

  it("reports a document without a session mapping as yaml_unreadable", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await writeFile(fixture.yamlPath, "schema_version: 0.2.0\nsession: 3\n");
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({
      status: "tampered",
      eventCount: 2,
      reason: "yaml_unreadable",
      sessionYamlInvalid: true,
    });
  });
});

// Rewrite a fixture's session.yaml top level (schema_version) and inner
// session mapping in one go.
async function rewriteSessionYaml(
  fixture: SessionFixture,
  mutate: (record: Record<string, unknown>, inner: Record<string, unknown>) => void,
): Promise<void> {
  const record = parseYaml(await readFile(fixture.yamlPath, "utf8")) as Record<string, unknown>;
  mutate(record, record.session as Record<string, unknown>);
  await writeFile(fixture.yamlPath, stringifyYaml(record));
}

function stripChain(fixture: SessionFixture): Promise<void> {
  return rewriteLines(
    fixture,
    fixture.lines.map((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>;
      delete obj.prev_hash;
      return JSON.stringify(obj);
    }),
  );
}

describe("verifyEventsChain — a session.yaml a newer basou wrote (unsupported)", () => {
  it("reports a format major other than 0 as unsupported, whatever the fields", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    await rewriteSessionYaml(fixture, (record) => {
      record.schema_version = "1.0.0";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unsupported", eventCount: 3, sessionYamlInvalid: true });
  });

  it("reports a newer minor whose status it does not know as unsupported", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    await rewriteSessionYaml(fixture, (record, inner) => {
      record.schema_version = "0.3.0";
      inner.status = "paused";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unsupported", eventCount: 3, sessionYamlInvalid: true });
  });

  it("reports a newer minor whose anchor carries a key it does not know as unsupported", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    await rewriteSessionYaml(fixture, (record, inner) => {
      record.schema_version = "0.3.0";
      inner.integrity = { head_hash: fixture.headHash, event_count: 3, signature: "sig" };
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unsupported", eventCount: 3, sessionYamlInvalid: true });
  });

  it("reports a newer minor without a session mapping as unsupported", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await writeFile(fixture.yamlPath, "schema_version: 0.3.0\nsession: 3\n");
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unsupported", eventCount: 2, sessionYamlInvalid: true });
  });

  it("compares versions numerically, patch included", async () => {
    const paths = await setupPaths();
    for (const version of ["0.10.0", "0.2.1"]) {
      const fixture = await writeChainedSession(paths, SES_ID, 2);
      await rewriteSessionYaml(fixture, (record, inner) => {
        record.schema_version = version;
        inner.status = "paused";
      });
      const verdict = await verifyEventsChain(paths, SES_ID);
      expect(verdict.status).toBe("unsupported");
    }
  });

  it("judges nothing under an unsupported document, a broken chain included", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    const lines = [...fixture.lines];
    lines[1] = (lines[1] as string).replace("note V2", "note v2");
    await rewriteLines(fixture, lines);
    await rewriteSessionYaml(fixture, (record) => {
      record.schema_version = "1.0.0";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("unsupported");
  });

  it("reports unsupported under an unchained log too", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await stripChain(fixture);
    await rewriteSessionYaml(fixture, (record) => {
      record.schema_version = "1.0.0";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unsupported", eventCount: 2, sessionYamlInvalid: true });
  });

  it("judges a newer minor normally when the three fields read", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3);
    await rewriteSessionYaml(fixture, (record, inner) => {
      record.schema_version = "0.3.0";
      inner.new_field_from_a_newer_minor = { any: "shape" };
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "verified", eventCount: 3 });
  });

  it("reports a tampered result under a newer minor as unsupported (anchor meaning may differ)", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 3, {
      anchor: { head_hash: "f".repeat(64), event_count: 3 },
    });
    await rewriteSessionYaml(fixture, (record) => {
      record.schema_version = "0.3.0";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unsupported", eventCount: 3 });
  });

  it("reports a chain it cannot follow under a newer minor as unsupported", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    const first = JSON.parse(fixture.lines[0] as string) as Record<string, unknown>;
    first.prev_hash = "0".repeat(64);
    await rewriteLines(fixture, [JSON.stringify(first), fixture.lines[1] as string]);
    await rewriteSessionYaml(fixture, (record) => {
      record.schema_version = "0.3.0";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unsupported", eventCount: 2 });
  });

  it("keeps a live session under a newer minor in_progress", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSessionWithStatus(paths, SES_ID, "running", {
      anchor: false,
    });
    await rewriteSessionYaml(fixture, (record) => {
      record.schema_version = "0.3.0";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "in_progress", eventCount: 3 });
  });

  it("keeps an empty log without an integrity key empty under a newer minor", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2, { anchor: false });
    await writeFile(fixture.eventsPath, "");
    await rewriteSessionYaml(fixture, (record, inner) => {
      record.schema_version = "0.3.0";
      inner.status = "paused";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "empty", eventCount: 0, sessionYamlInvalid: true });
  });

  it("reports an integrity key under an unchained log at a newer minor as unsupported", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await stripChain(fixture);
    await rewriteSessionYaml(fixture, (record, inner) => {
      record.schema_version = "0.3.0";
      inner.status = "paused";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unsupported", eventCount: 2, sessionYamlInvalid: true });
  });

  it("reads a pre-release of a foreign major as unsupported", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await rewriteSessionYaml(fixture, (record) => {
      record.schema_version = "1.0.0-rc.1";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("unsupported");
  });

  it("does not read a version with a leading zero as newer", async () => {
    const paths = await setupPaths();
    for (const version of ["0.03.0", "00.3.0", "0.2.00"]) {
      const fixture = await writeChainedSession(paths, SES_ID, 2);
      await rewriteSessionYaml(fixture, (record, inner) => {
        record.schema_version = version;
        inner.status = "paused";
      });
      const verdict = await verifyEventsChain(paths, SES_ID);
      expect(verdict.status).toBe("tampered");
      expect(verdict.reason).toBe("yaml_unreadable");
    }
  });

  it("still reports an unknown status at a known version as yaml_unreadable", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await rewriteSessionYaml(fixture, (record, inner) => {
      record.schema_version = "0.2.0";
      inner.status = "paused";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({
      status: "tampered",
      eventCount: 2,
      reason: "yaml_unreadable",
      sessionYamlInvalid: true,
    });
  });
});

describe("verifyEventsChain — an integrity key under an unchained log", () => {
  it("reports a null integrity under an unchained log as anchor_without_chain", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await stripChain(fixture);
    await rewriteSessionYaml(fixture, (_record, inner) => {
      inner.integrity = null;
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({
      status: "tampered",
      eventCount: 2,
      reason: "anchor_without_chain",
      sessionYamlInvalid: true,
    });
  });

  it("reports a malformed anchor under an unchained log as anchor_without_chain", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await stripChain(fixture);
    await rewriteSessionYaml(fixture, (_record, inner) => {
      inner.integrity = { head_hash: fixture.headHash, event_count: "2" };
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_without_chain");
  });

  it("reports a valid anchor beside an invalid status under an unchained log as anchor_without_chain", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await stripChain(fixture);
    await rewriteSessionYaml(fixture, (_record, inner) => {
      inner.status = "paused";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_without_chain");
  });

  it("reports an anchor under an empty log as anchor_without_chain even when the status is invalid", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await writeFile(fixture.eventsPath, "");
    await rewriteSessionYaml(fixture, (_record, inner) => {
      inner.status = "paused";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("anchor_without_chain");
  });

  it("leaves an unchained log without an integrity key unchained when the status is invalid", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2, { anchor: false });
    await stripChain(fixture);
    await rewriteSessionYaml(fixture, (_record, inner) => {
      inner.status = "paused";
    });
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unchained", eventCount: 2, sessionYamlInvalid: true });
  });
});

// What basou verify reads from session.yaml, and how the chain is hashed, are
// pinned to the session format version. If this fails, you changed one of
// them: move SESSION_SCHEMA_VERSION (docs/spec/schemas.md §7.3) and update
// this snapshot in the same change, so an older verify reports a newer
// writer's session `unsupported` instead of `tampered`.
describe("what verify reads is pinned to the session format version", () => {
  it("matches the snapshot for this format version", () => {
    expect({
      version: SESSION_SCHEMA_VERSION,
      status: SessionStatusSchema.options,
      integrityKeys: Object.keys(SessionIntegritySchema.shape),
      genesis: genesisHash(SES_ID),
      line: lineHash(Buffer.from('{"a":1}')),
    }).toEqual({
      version: "0.2.0",
      status: [
        "initialized",
        "running",
        "waiting_approval",
        "completed",
        "failed",
        "interrupted",
        "imported",
        "archived",
      ],
      integrityKeys: ["head_hash", "event_count"],
      genesis: "50d06e5463fea393c7e5cc620d847a40fe64e2b93e476ed3e4903465922b1fcc",
      line: "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    });
  });
});

describe("verifyEventsChain — a session.yaml whose top level is not a mapping", () => {
  it("reports a list, a scalar or an empty file on a chained log as yaml_unreadable", async () => {
    const paths = await setupPaths();
    for (const body of ["- schema_version: 1.0.0\n", "1.0.0\n", ""]) {
      const fixture = await writeChainedSession(paths, SES_ID, 2);
      await writeFile(fixture.yamlPath, body);
      const verdict = await verifyEventsChain(paths, SES_ID);
      expect(verdict).toEqual({
        status: "tampered",
        eventCount: 2,
        reason: "yaml_unreadable",
        sessionYamlInvalid: true,
      });
    }
  });

  it("finds no integrity key in a list under an unchained log", async () => {
    const paths = await setupPaths();
    const fixture = await writeChainedSession(paths, SES_ID, 2);
    await stripChain(fixture);
    await writeFile(fixture.yamlPath, "- session:\n    integrity: null\n");
    const verdict = await verifyEventsChain(paths, SES_ID);
    expect(verdict).toEqual({ status: "unchained", eventCount: 2, sessionYamlInvalid: true });
  });
});
