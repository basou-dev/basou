import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Event } from "../schemas/event.schema.js";
import { chainEvents, genesisHash, lineHash, serializeEventLine } from "./chain.js";

const SES_ID = "ses_01HXABCDEF1234567890ABCSE1";
const OTHER_SES_ID = "ses_01HXABCDEF1234567890ABCSE2";

function makeEvent(suffix: string, extra: Partial<Event> = {}): Event {
  return {
    schema_version: "0.1.0",
    id: `evt_01HXABCDEF1234567890ABCE${suffix}`,
    session_id: SES_ID,
    occurred_at: "2026-05-04T09:00:00+09:00",
    source: "codex-import",
    type: "note_added",
    body: `note ${suffix}`,
    ...extra,
  } as Event;
}

describe("genesisHash", () => {
  it("is deterministic and hex sha-256 shaped", () => {
    const a = genesisHash(SES_ID);
    expect(a).toBe(genesisHash(SES_ID));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is bound to the session id", () => {
    expect(genesisHash(SES_ID)).not.toBe(genesisHash(OTHER_SES_ID));
  });

  it("matches the documented domain-separated construction", () => {
    const expected = createHash("sha256")
      .update(`basou:event-chain:v1:${SES_ID}`, "utf8")
      .digest("hex");
    expect(genesisHash(SES_ID)).toBe(expected);
  });
});

describe("lineHash", () => {
  it("hashes the literal line bytes", () => {
    const line = '{"a":1}';
    const expected = createHash("sha256").update(line, "utf8").digest("hex");
    expect(lineHash(line)).toBe(expected);
  });
});

describe("chainEvents", () => {
  it("threads genesis -> per-line back-pointers and returns the head", () => {
    const events = [makeEvent("V1"), makeEvent("V2"), makeEvent("V3")];
    const { lines, headHash, count } = chainEvents(events, SES_ID);

    expect(count).toBe(3);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l) as { prev_hash: string });
    expect(parsed[0]?.prev_hash).toBe(genesisHash(SES_ID));
    expect(parsed[1]?.prev_hash).toBe(lineHash(lines[0] as string));
    expect(parsed[2]?.prev_hash).toBe(lineHash(lines[1] as string));
    expect(headHash).toBe(lineHash(lines[2] as string));
  });

  it("discards an incoming prev_hash and recomputes it", () => {
    const poisoned = makeEvent("V1", { prev_hash: "f".repeat(64) } as Partial<Event>);
    const { lines } = chainEvents([poisoned], SES_ID);
    const parsed = JSON.parse(lines[0] as string) as { prev_hash: string };
    expect(parsed.prev_hash).toBe(genesisHash(SES_ID));
  });

  it("returns the genesis hash and zero count for an empty batch", () => {
    const { lines, headHash, count } = chainEvents([], SES_ID);
    expect(lines).toHaveLength(0);
    expect(count).toBe(0);
    expect(headHash).toBe(genesisHash(SES_ID));
  });

  it("serializes through the shared single serializer", () => {
    const event = makeEvent("V1");
    const { lines } = chainEvents([event], SES_ID);
    const expected = serializeEventLine({ ...event, prev_hash: genesisHash(SES_ID) });
    expect(lines[0]).toBe(expected);
  });
});
