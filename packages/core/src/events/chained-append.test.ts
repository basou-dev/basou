import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../schemas/event.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { chainEvents, genesisHash, lineHash } from "./chain.js";
import {
  appendChainedEvent,
  appendChainedEventLocked,
  inspectChainTail,
} from "./chained-append.js";

const SES_ID = "ses_01HXABCDEF1234567890ABCSE1";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-chained-append-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

async function setup(): Promise<{ paths: BasouPaths; sessionDir: string; eventsPath: string }> {
  if (workDir === undefined) throw new Error("workDir not initialized");
  const paths = await ensureBasouDirectory(workDir);
  const sessionDir = join(paths.sessions, SES_ID);
  await mkdir(sessionDir, { recursive: true });
  return { paths, sessionDir, eventsPath: join(sessionDir, "events.jsonl") };
}

function makeEvent(suffix: string): Event {
  return {
    schema_version: "0.1.0",
    id: `evt_01HXABCDEF1234567890ABCE${suffix}`,
    session_id: SES_ID,
    occurred_at: "2026-06-12T09:00:00+09:00",
    source: "terminal-recording",
    type: "note_added",
    body: `note ${suffix}`,
  } as Event;
}

async function readLines(eventsPath: string): Promise<string[]> {
  const raw = await readFile(eventsPath, "utf8");
  return raw.length === 0 ? [] : raw.replace(/\n$/, "").split("\n");
}

describe("inspectChainTail", () => {
  it("treats a missing log as a chained genesis", async () => {
    const { paths } = await setup();
    const tail = await inspectChainTail(paths, SES_ID);
    expect(tail).toEqual({ chained: true, head: genesisHash(SES_ID), count: 0 });
  });

  it("treats a zero-byte log as a chained genesis", async () => {
    const { paths, eventsPath } = await setup();
    await writeFile(eventsPath, "");
    const tail = await inspectChainTail(paths, SES_ID);
    expect(tail).toEqual({ chained: true, head: genesisHash(SES_ID), count: 0 });
  });

  it("reports a chained log's head as the last line hash", async () => {
    const { paths, eventsPath } = await setup();
    const { lines, headHash, count } = chainEvents([makeEvent("V1"), makeEvent("V2")], SES_ID);
    await writeFile(eventsPath, `${lines.join("\n")}\n`);
    const tail = await inspectChainTail(paths, SES_ID);
    expect(tail).toEqual({ chained: true, head: headHash, count });
  });

  it("reports an unchained log as not chained", async () => {
    const { paths, eventsPath } = await setup();
    await writeFile(eventsPath, `${JSON.stringify(makeEvent("V1"))}\n`);
    const tail = await inspectChainTail(paths, SES_ID);
    expect(tail.chained).toBe(false);
    expect(tail.count).toBe(1);
  });

  it("throws on an unterminated final line (torn tail)", async () => {
    const { paths, eventsPath } = await setup();
    const { lines } = chainEvents([makeEvent("V1")], SES_ID);
    await writeFile(eventsPath, lines[0] as string); // no trailing newline
    await expect(inspectChainTail(paths, SES_ID)).rejects.toThrow(
      "Unterminated final line in events.jsonl",
    );
  });

  it("throws when the first and last lines disagree on chained-ness (mixed)", async () => {
    const { paths, eventsPath } = await setup();
    const { lines } = chainEvents([makeEvent("V1")], SES_ID);
    const plain = JSON.stringify(makeEvent("V2")); // no prev_hash
    await writeFile(eventsPath, `${lines[0]}\n${plain}\n`);
    await expect(inspectChainTail(paths, SES_ID)).rejects.toThrow(
      "events.jsonl is partially chained",
    );
  });
});

describe("appendChainedEventLocked", () => {
  it("chains a fresh session from genesis, matching chainEvents byte-for-byte", async () => {
    const { paths, eventsPath } = await setup();
    const events = [makeEvent("V1"), makeEvent("V2"), makeEvent("V3")];
    for (const ev of events) {
      const result = await appendChainedEventLocked(paths, SES_ID, ev);
      expect(result.chained).toBe(true);
    }
    const expected = chainEvents(events, SES_ID).lines;
    expect(await readLines(eventsPath)).toEqual(expected);

    const written = await readLines(eventsPath);
    const first = JSON.parse(written[0] as string) as Record<string, unknown>;
    expect(first.prev_hash).toBe(genesisHash(SES_ID));
    const second = JSON.parse(written[1] as string) as Record<string, unknown>;
    expect(second.prev_hash).toBe(lineHash(written[0] as string));
  });

  it("appends a PLAIN unchained line onto a legacy unchained log", async () => {
    const { paths, eventsPath } = await setup();
    await writeFile(eventsPath, `${JSON.stringify(makeEvent("V1"))}\n`);
    const result = await appendChainedEventLocked(paths, SES_ID, makeEvent("V2"));
    expect(result.chained).toBe(false);
    const lines = await readLines(eventsPath);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(JSON.parse(l) as Record<string, unknown>).not.toHaveProperty("prev_hash");
    }
  });

  it("rejects an invalid event payload", async () => {
    const { paths } = await setup();
    await expect(appendChainedEventLocked(paths, SES_ID, { not: "an event" })).rejects.toThrow(
      "Invalid Basou event payload",
    );
  });

  it("refuses to append onto a torn tail", async () => {
    const { paths, eventsPath } = await setup();
    const { lines } = chainEvents([makeEvent("V1")], SES_ID);
    await writeFile(eventsPath, lines[0] as string);
    await expect(appendChainedEventLocked(paths, SES_ID, makeEvent("V2"))).rejects.toThrow(
      "Unterminated final line in events.jsonl",
    );
  });
});

describe("appendChainedEvent (self-locking)", () => {
  it("acquires the session lock and chains the append", async () => {
    const { paths, eventsPath } = await setup();
    await appendChainedEvent(paths, SES_ID, makeEvent("V1"));
    await appendChainedEvent(paths, SES_ID, makeEvent("V2"));
    const expected = chainEvents([makeEvent("V1"), makeEvent("V2")], SES_ID).lines;
    expect(await readLines(eventsPath)).toEqual(expected);
  });
});
