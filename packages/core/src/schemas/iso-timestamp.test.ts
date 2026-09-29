import { describe, expect, it } from "vitest";
import { EventSchema } from "./event.schema.js";
import {
  normalizeEventTimestamps,
  normalizeIsoTimestamp,
  normalizeSessionTimestamps,
} from "./iso-timestamp.js";
import { SessionSchema } from "./session.schema.js";
import { IsoTimestampSchema } from "./shared.schema.js";

describe("normalizeEventTimestamps", () => {
  const base = {
    schema_version: "0.2.0",
    id: "evt_01M3PWQAZBN24WGZBF29B3F7R9",
    session_id: "ses_01M3PWQAZBN24WGZBF29B3F7R8",
    source: "third-party",
  };

  it("restores occurred_at, so the event parses instead of being dropped", () => {
    const raw = { ...base, type: "session_started", occurred_at: "2026-09-16T01:23Z" };
    expect(EventSchema.safeParse(raw).success).toBe(false);
    const parsed = EventSchema.safeParse(normalizeEventTimestamps(raw));
    expect(parsed.success && parsed.data.occurred_at).toBe("2026-09-16T01:23:00Z");
  });

  it("restores an approval request's expires_at as well", () => {
    const raw = {
      ...base,
      type: "approval_requested",
      occurred_at: "2026-09-16T01:23:00Z",
      approval_id: "apr_01M3PWQAZBN24WGZBF29B3F7R9",
      expires_at: "2026-09-16T02:00+09:00",
      risk_level: "low",
      action: { kind: "shell_command" },
      reason: "r",
    };
    expect(normalizeEventTimestamps(raw)).toMatchObject({
      expires_at: "2026-09-16T02:00:00+09:00",
    });
  });

  it("leaves a field of the same name alone on any other event type", () => {
    const raw = {
      ...base,
      type: "note_added",
      occurred_at: "2026-09-16T01:23Z",
      expires_at: "2026-09-16T02:00Z",
    };
    expect(normalizeEventTimestamps(raw)).toMatchObject({
      occurred_at: "2026-09-16T01:23:00Z",
      expires_at: "2026-09-16T02:00Z",
    });
  });

  it("widens nothing: a value it does not recognize is still refused", () => {
    const raw = { ...base, type: "session_started", occurred_at: "2026-09-16t01:23z" };
    expect(EventSchema.safeParse(normalizeEventTimestamps(raw)).success).toBe(false);
  });

  it("passes a non-object through for the schema to refuse", () => {
    expect(normalizeEventTimestamps(null)).toBeNull();
    expect(normalizeEventTimestamps(["a"])).toEqual(["a"]);
  });
});

describe("normalizeSessionTimestamps", () => {
  const session = {
    id: "ses_01M3PWQAZBN24WGZBF29B3F7R8",
    workspace_id: "ws_01M3PWQ1WYXGYT1T75WFX7D5NQ",
    source: { kind: "import", version: "0.1.0" },
    status: "imported",
    working_directory: "~/somewhere",
    invocation: { command: "producer", args: [], exit_code: 0 },
    related_files: [],
  };

  it("restores started_at, ended_at and every active interval bound", () => {
    const raw = {
      schema_version: "0.1.0",
      session: {
        ...session,
        started_at: "2026-09-16T01:23Z",
        ended_at: "2026-09-16T01:30+09:00",
        metrics: {
          output_tokens: 1,
          active_intervals: [{ start: "2026-09-16T01:23Z", end: "2026-09-16T01:24Z" }],
        },
      },
    };
    expect(SessionSchema.safeParse(raw).success).toBe(false);
    const parsed = SessionSchema.safeParse(normalizeSessionTimestamps(raw));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.session.started_at).toBe("2026-09-16T01:23:00Z");
    expect(parsed.data.session.ended_at).toBe("2026-09-16T01:30:00+09:00");
    expect(parsed.data.session.metrics?.active_intervals).toEqual([
      { start: "2026-09-16T01:23:00Z", end: "2026-09-16T01:24:00Z" },
    ]);
    expect(parsed.data.session.metrics?.output_tokens).toBe(1);
  });

  it("widens nothing: a value it does not recognize is still refused", () => {
    const raw = { schema_version: "0.1.0", session: { ...session, started_at: "yesterday" } };
    expect(SessionSchema.safeParse(normalizeSessionTimestamps(raw)).success).toBe(false);
  });

  it("passes a document without a session object through", () => {
    expect(normalizeSessionTimestamps({ schema_version: "0.1.0" })).toEqual({
      schema_version: "0.1.0",
    });
    expect(normalizeSessionTimestamps("text")).toBe("text");
  });
});

describe("normalizeIsoTimestamp", () => {
  // The point of the boundary: a vendor that omits seconds must not have its
  // trace dropped as a schema violation. Each case below is stated as "what
  // goes in" -> "what the schema then says", because the pair is the contract,
  // not the string transformation on its own.
  it.each([
    ["a seconds-less UTC value gains :00", "2026-05-10T09:00Z", "2026-05-10T09:00:00Z"],
    [
      "a seconds-less offset value keeps its offset",
      "2026-05-10T09:00+09:00",
      "2026-05-10T09:00:00+09:00",
    ],
    [
      "a negative offset is preserved, not folded to UTC",
      "2026-05-10T09:00-05:00",
      "2026-05-10T09:00:00-05:00",
    ],
  ])("%s", (_label, raw, expected) => {
    expect(normalizeIsoTimestamp(raw)).toBe(expected);
    expect(IsoTimestampSchema.safeParse(normalizeIsoTimestamp(raw)).success).toBe(true);
  });

  it.each([
    ["an already-complete value is untouched", "2026-05-10T09:00:00.123Z"],
    ["seconds without fraction are untouched", "2026-05-10T09:00:00Z"],
  ])("%s", (_label, raw) => {
    expect(normalizeIsoTimestamp(raw)).toBe(raw);
  });

  // What it deliberately does NOT do. Widening the accepted set here rather
  // than through a `schema_version` would put the schema and the importer back
  // out of step, which is the drift the pinned pattern exists to prevent.
  it.each([
    ["lowercase designators stay outside the set", "2026-05-10t09:00z"],
    ["a leap second is not smuggled in", "2026-12-31T23:59:60Z"],
    ["a zone-less value is not given one", "2026-05-10T09:00:00"],
    ["a non-timestamp is returned as-is", "not a timestamp"],
  ])("%s", (_label, raw) => {
    expect(normalizeIsoTimestamp(raw)).toBe(raw);
    expect(IsoTimestampSchema.safeParse(normalizeIsoTimestamp(raw)).success).toBe(false);
  });

  it("adds seconds by shape alone, and does not make an impossible day possible", () => {
    // The normalizer reads the shape, not the calendar, so a day that does not
    // exist still gains its `:00`. That is deliberate: deciding which dates are
    // real is the schema's job, and doing it in two places is how the two drift
    // apart. What matters is that the value is still refused.
    expect(normalizeIsoTimestamp("2026-02-30T09:00Z")).toBe("2026-02-30T09:00:00Z");
    expect(IsoTimestampSchema.safeParse("2026-02-30T09:00:00Z").success).toBe(false);
  });

  it("is idempotent", () => {
    const once = normalizeIsoTimestamp("2026-05-10T09:00Z");
    expect(normalizeIsoTimestamp(once)).toBe(once);
  });
});
