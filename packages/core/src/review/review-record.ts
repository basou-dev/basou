import type { PrefixedId } from "../ids/ulid.js";
import type { Event, ReviewBlocked, ReviewFinding } from "../schemas/event.schema.js";

/**
 * The deterministic writer for `basou review record` — the twin of
 * `basou decision capture`. The in-loop agent runs a review (with a
 * vendor-specific command), then pipes a JSON object describing what ran;
 * basou parses + validates it here and writes a `review_recorded` event,
 * with NO runtime LLM. Keeping parse + build in core (rather than the CLI,
 * where `decision capture` happens to live) makes the writer unit-testable
 * on its own and reusable by the read-only `review-gaps` surfacer.
 *
 * This is a self-report: basou records that a review happened; it does not
 * verify the review actually executed. Cryptographic enforcement is the
 * bridle's (mcp-bridle) concern — core stays read-only/advisory.
 */

/** A finding in the review record input (the on-wire `findings[]` shape). */
export type ReviewRecordFindingInput = ReviewFinding;

/** A blocked finding in the review record input (the on-wire `blocked[]` shape). */
export type ReviewRecordBlockedInput = ReviewBlocked;

/** A parsed + validated review record: required minimum + optional rich fields. */
export type ReviewRecordInput = {
  /** What/who reviewed (e.g. "codex", a model name, "self"). Required. */
  reviewer: string;
  /** What was reviewed (e.g. "working-tree", a git ref, "PR #145"). Required. */
  target: string;
  /** Overall outcome. Optional. */
  verdict?: "pass" | "needs-attention" | "fail";
  /** Findings surfaced by the review. Optional. */
  findings?: ReviewRecordFindingInput[];
  /**
   * Findings blocked as spec-deviation / design-reversal. Optional, but an
   * explicit empty array is encouraged — it records "I blocked nothing" as the
   * adversarial-review protocol requires.
   */
  blocked?: ReviewRecordBlockedInput[];
};

const VALID_VERDICTS: ReadonlySet<string> = new Set(["pass", "needs-attention", "fail"]);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const VALID_BLOCK_REASONS: ReadonlySet<string> = new Set(["spec-deviation", "design-reversal"]);

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "reviewer",
  "target",
  "verdict",
  "findings",
  "blocked",
]);
const ALLOWED_FINDING_KEYS: ReadonlySet<string> = new Set([
  "title",
  "severity",
  "location",
  "summary",
]);
const ALLOWED_BLOCKED_KEYS: ReadonlySet<string> = new Set(["title", "reason", "why"]);

/** Actionable hint shown when nothing is piped in. */
export const REVIEW_RECORD_NO_INPUT_HINT =
  "No input: pipe a JSON object describing the review to stdin or pass --file <path>.";

/**
 * Parse + validate the review record input — a SINGLE JSON object (one
 * invocation = one review), unlike `decision capture`'s array. Errors name the
 * offending field (e.g. `findings[2].severity must be ...`) so the in-loop
 * agent can self-correct without guessing. Pure: no disk/environment access.
 */
export function parseReviewRecordInput(raw: string): ReviewRecordInput {
  if (raw.trim().length === 0) {
    throw new Error(REVIEW_RECORD_NO_INPUT_HINT);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Input is not valid JSON: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Input must be a single JSON object describing one review.");
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `Unknown field '${key}'. Allowed: reviewer, target, verdict, findings, blocked.`,
      );
    }
  }

  const reviewer = requireNonEmptyString(obj.reviewer, "reviewer");
  const target = requireNonEmptyString(obj.target, "target");
  const out: ReviewRecordInput = { reviewer, target };

  if (obj.verdict !== undefined) {
    if (typeof obj.verdict !== "string" || !VALID_VERDICTS.has(obj.verdict)) {
      throw new Error(`verdict must be one of pass, needs-attention, fail, got '${obj.verdict}'.`);
    }
    out.verdict = obj.verdict as "pass" | "needs-attention" | "fail";
  }
  if (obj.findings !== undefined) {
    out.findings = parseFindings(obj.findings);
  }
  if (obj.blocked !== undefined) {
    out.blocked = parseBlocked(obj.blocked);
  }
  return out;
}

function parseFindings(value: unknown): ReviewRecordFindingInput[] {
  if (!Array.isArray(value)) {
    throw new Error("findings must be an array of objects.");
  }
  return value.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`findings[${i}] must be a JSON object.`);
    }
    const obj = item as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_FINDING_KEYS.has(key)) {
        throw new Error(
          `findings[${i}]: unknown field '${key}'. Allowed: title, severity, location, summary.`,
        );
      }
    }
    const finding: ReviewRecordFindingInput = {
      title: requireNonEmptyString(obj.title, `findings[${i}].title`),
    };
    if (obj.severity !== undefined) {
      if (typeof obj.severity !== "string" || !VALID_SEVERITIES.has(obj.severity)) {
        throw new Error(
          `findings[${i}].severity must be one of high, medium, low, got '${obj.severity}'.`,
        );
      }
      finding.severity = obj.severity as "high" | "medium" | "low";
    }
    if (obj.location !== undefined) {
      finding.location = requireNonEmptyString(obj.location, `findings[${i}].location`);
    }
    if (obj.summary !== undefined) {
      finding.summary = requireNonEmptyString(obj.summary, `findings[${i}].summary`);
    }
    return finding;
  });
}

function parseBlocked(value: unknown): ReviewRecordBlockedInput[] {
  if (!Array.isArray(value)) {
    throw new Error("blocked must be an array of objects.");
  }
  return value.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`blocked[${i}] must be a JSON object.`);
    }
    const obj = item as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_BLOCKED_KEYS.has(key)) {
        throw new Error(`blocked[${i}]: unknown field '${key}'. Allowed: title, reason, why.`);
      }
    }
    if (typeof obj.reason !== "string" || !VALID_BLOCK_REASONS.has(obj.reason)) {
      throw new Error(
        `blocked[${i}].reason must be one of spec-deviation, design-reversal, got '${obj.reason}'.`,
      );
    }
    const blocked: ReviewRecordBlockedInput = {
      title: requireNonEmptyString(obj.title, `blocked[${i}].title`),
      reason: obj.reason as "spec-deviation" | "design-reversal",
    };
    if (obj.why !== undefined) {
      blocked.why = requireNonEmptyString(obj.why, `blocked[${i}].why`);
    }
    return blocked;
  });
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

/**
 * Build the `review_recorded` event from a validated input. Mirrors
 * `buildDecisionEvent`: optional fields are spread only when present so an
 * event with just the required minimum round-trips byte-identically.
 */
export function buildReviewRecordedEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  occurredAt: string;
  review: ReviewRecordInput;
}): Event {
  const { review } = input;
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "review_recorded",
    reviewer: review.reviewer,
    target: review.target,
    ...(review.verdict !== undefined ? { verdict: review.verdict } : {}),
    ...(review.findings !== undefined ? { findings: review.findings } : {}),
    ...(review.blocked !== undefined ? { blocked: review.blocked } : {}),
  };
}

/** Max length of the reviewer/target fragment in an ad-hoc session label. */
const LABEL_FRAGMENT_MAX = 40;

/** Ad-hoc session label for a recorded review: `Ad-hoc review: <reviewer> -> <target>`. */
export function buildReviewRecordLabel(review: ReviewRecordInput): string {
  return `Ad-hoc review: ${truncate(review.reviewer)} -> ${truncate(review.target)}`;
}

function truncate(value: string): string {
  return value.length > LABEL_FRAGMENT_MAX ? `${value.slice(0, LABEL_FRAGMENT_MAX - 3)}...` : value;
}
