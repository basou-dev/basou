import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import type { Event } from "../schemas/event.schema.js";
import type { Session, SessionIntegrity } from "../schemas/session.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { chainEvents } from "./chain.js";
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
    expect(verdict.status).toBe("tampered");
    expect(verdict.reason).toBe("torn_tail");
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
