import { describe, expect, it } from "vitest";
import { EventSchema } from "../schemas/event.schema.js";
import {
  buildReviewRecordedEvent,
  buildReviewRecordLabel,
  parseReviewRecordInput,
} from "./review-record.js";

const EVENT_ID = "evt_01HXABCDEF1234567890ABCDEF" as const;
const SESSION_ID = "ses_01HXABCDEF1234567890ABCDEF" as const;
const OCCURRED_AT = "2026-06-30T09:00:00+09:00";

describe("parseReviewRecordInput", () => {
  it("parses the required minimum (reviewer + target)", () => {
    const review = parseReviewRecordInput('{ "reviewer": "codex", "target": "working-tree" }');
    expect(review).toEqual({ reviewer: "codex", target: "working-tree" });
  });

  it("parses every optional field", () => {
    const review = parseReviewRecordInput(
      JSON.stringify({
        reviewer: "codex",
        target: "PR #145",
        verdict: "needs-attention",
        findings: [
          { title: "Off-by-one", severity: "medium", location: "src/p.ts:42", summary: "edge" },
          { title: "bare finding" },
        ],
        blocked: [{ title: "drop singleton", reason: "design-reversal", why: "settled" }],
      }),
    );
    expect(review.verdict).toBe("needs-attention");
    expect(review.findings).toHaveLength(2);
    expect(review.blocked?.[0]).toEqual({
      title: "drop singleton",
      reason: "design-reversal",
      why: "settled",
    });
  });

  it("preserves an explicit empty blocked array", () => {
    const review = parseReviewRecordInput('{ "reviewer": "codex", "target": "wt", "blocked": [] }');
    expect(review.blocked).toEqual([]);
  });

  it("throws on empty input", () => {
    expect(() => parseReviewRecordInput("   ")).toThrow(/No input/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseReviewRecordInput("{ not json")).toThrow(/not valid JSON/);
  });

  it("throws when the input is a JSON array (must be a single object)", () => {
    expect(() => parseReviewRecordInput('[{ "reviewer": "codex", "target": "wt" }]')).toThrow(
      /single JSON object/,
    );
  });

  it("throws on an unknown top-level field", () => {
    expect(() =>
      parseReviewRecordInput('{ "reviewer": "codex", "target": "wt", "score": 9 }'),
    ).toThrow(/Unknown field 'score'/);
  });

  it("throws when reviewer is missing or blank", () => {
    expect(() => parseReviewRecordInput('{ "target": "wt" }')).toThrow(/reviewer must be/);
    expect(() => parseReviewRecordInput('{ "reviewer": "  ", "target": "wt" }')).toThrow(
      /reviewer must be/,
    );
  });

  it("throws when target is missing", () => {
    expect(() => parseReviewRecordInput('{ "reviewer": "codex" }')).toThrow(/target must be/);
  });

  it("throws on an unknown verdict", () => {
    expect(() =>
      parseReviewRecordInput('{ "reviewer": "c", "target": "wt", "verdict": "lgtm" }'),
    ).toThrow(/verdict must be one of/);
  });

  it("throws on a finding without a title", () => {
    expect(() =>
      parseReviewRecordInput(
        '{ "reviewer": "c", "target": "wt", "findings": [{ "severity": "low" }] }',
      ),
    ).toThrow(/findings\[0\]\.title must be/);
  });

  it("throws on an unknown finding severity", () => {
    expect(() =>
      parseReviewRecordInput(
        '{ "reviewer": "c", "target": "wt", "findings": [{ "title": "x", "severity": "critical" }] }',
      ),
    ).toThrow(/findings\[0\]\.severity must be one of/);
  });

  it("throws on an unknown finding field", () => {
    expect(() =>
      parseReviewRecordInput(
        '{ "reviewer": "c", "target": "wt", "findings": [{ "title": "x", "tags": [] }] }',
      ),
    ).toThrow(/findings\[0\]: unknown field 'tags'/);
  });

  it("throws on a blocked entry with an unknown reason", () => {
    expect(() =>
      parseReviewRecordInput(
        '{ "reviewer": "c", "target": "wt", "blocked": [{ "title": "x", "reason": "nit" }] }',
      ),
    ).toThrow(/blocked\[0\]\.reason must be one of/);
  });

  it("throws on a blocked entry missing the reason", () => {
    expect(() =>
      parseReviewRecordInput('{ "reviewer": "c", "target": "wt", "blocked": [{ "title": "x" }] }'),
    ).toThrow(/blocked\[0\]\.reason must be one of/);
  });

  it("throws when findings is not an array", () => {
    expect(() =>
      parseReviewRecordInput('{ "reviewer": "c", "target": "wt", "findings": {} }'),
    ).toThrow(/findings must be an array/);
  });
});

describe("buildReviewRecordedEvent", () => {
  it("builds an event that the EventSchema accepts (required minimum)", () => {
    const review = parseReviewRecordInput('{ "reviewer": "codex", "target": "working-tree" }');
    const event = buildReviewRecordedEvent({
      eventId: EVENT_ID,
      sessionId: SESSION_ID,
      occurredAt: OCCURRED_AT,
      review,
    });
    const parsed = EventSchema.parse(event);
    if (parsed.type !== "review_recorded") throw new Error("narrowing failed");
    expect(parsed.reviewer).toBe("codex");
    expect(parsed.target).toBe("working-tree");
    expect(parsed.source).toBe("local-cli");
    // Optional fields omitted entirely (not present as undefined keys).
    expect(Object.keys(parsed)).not.toContain("verdict");
    expect(Object.keys(parsed)).not.toContain("findings");
    expect(Object.keys(parsed)).not.toContain("blocked");
  });

  it("carries every optional field through into a schema-valid event", () => {
    const review = parseReviewRecordInput(
      JSON.stringify({
        reviewer: "codex",
        target: "PR #145",
        verdict: "fail",
        findings: [{ title: "bug", severity: "high" }],
        blocked: [{ title: "scope creep", reason: "spec-deviation" }],
      }),
    );
    const event = buildReviewRecordedEvent({
      eventId: EVENT_ID,
      sessionId: SESSION_ID,
      occurredAt: OCCURRED_AT,
      review,
    });
    const parsed = EventSchema.parse(event);
    if (parsed.type !== "review_recorded") throw new Error("narrowing failed");
    expect(parsed.verdict).toBe("fail");
    expect(parsed.findings).toEqual([{ title: "bug", severity: "high" }]);
    expect(parsed.blocked).toEqual([{ title: "scope creep", reason: "spec-deviation" }]);
  });
});

describe("buildReviewRecordLabel", () => {
  it("renders reviewer -> target", () => {
    expect(buildReviewRecordLabel({ reviewer: "codex", target: "working-tree" })).toBe(
      "Ad-hoc review: codex -> working-tree",
    );
  });

  it("truncates an overlong fragment", () => {
    const label = buildReviewRecordLabel({ reviewer: "codex", target: "x".repeat(60) });
    expect(label.length).toBeLessThan(`Ad-hoc review: codex -> ${"x".repeat(60)}`.length);
    expect(label).toContain("...");
  });
});
