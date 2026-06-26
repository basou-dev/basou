import { type PrefixedId, prefixedUlid } from "../../ids/ulid.js";
import type { Event } from "../../schemas/event.schema.js";
import type { Manifest } from "../../schemas/manifest.schema.js";
import type { SessionImportPayload } from "../../schemas/session-import.schema.js";
import {
  ACTIVE_GAP_CAP_MS,
  activeTimeFromTimestamps,
  ENGAGED_TURNS_METHOD,
  intervalsMsToIso,
} from "../../stats/active-time.js";
import { sessionLabelDateSpan } from "../session-label.js";
import { indexAskAnswers, readOfferedOptions } from "./ask-user-question.js";

/**
 * The `source` string stamped on every event derived from a Claude Code
 * native transcript, and the matching session `source.kind`.
 */
export const CLAUDE_IMPORT_SOURCE = "claude-code-import";

/**
 * One parsed line of a Claude Code native transcript
 * (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`). The shape is the
 * vendor's internal message log, not Basou's event schema, so every field
 * is read defensively — unknown record types and missing fields are skipped
 * rather than rejected (transcripts are an undocumented format that may gain
 * fields between Claude Code releases).
 */
export type ClaudeTranscriptRecord = Record<string, unknown>;

/** Options for {@link claudeTranscriptToImportPayload}. */
export type ClaudeTranscriptToPayloadOptions = {
  /** Workspace id of the target Basou workspace (from its manifest). */
  workspaceId: Manifest["workspace"]["id"];
  /**
   * Claude Code session id (transcript filename / `sessionId`). Stored as
   * `session.source.external_id` so re-imports can be deduplicated. Falls
   * back to the `sessionId` read from the records when omitted.
   */
  externalId?: string;
  /**
   * Byte size of the source transcript that produced `records`, stored as
   * `session.source.source_size_bytes` so a later import can detect growth and
   * re-import the session. The caller passes the size of the buffer it actually
   * read (an immutable snapshot of the parsed bytes), so the stored size always
   * matches the imported content. Omitted => the field is not recorded.
   */
  sourceSizeBytes?: number;
};

/**
 * Transform a Claude Code native transcript into a Basou
 * {@link SessionImportPayload}, ready to hand to `importSessionFromJson`.
 *
 * This is a pure function: no disk or environment access. It DERIVES Basou's
 * provenance-level events from the transcript's message-level records, rather
 * than mapping one-to-one:
 *
 * - `session_started` / `session_ended` from the first / last timestamped record.
 * - `command_executed` from each `Bash` tool use, recorded as `bash -c "<cmd>"`
 *   (the transcript carries the shell line, not a parsed argv).
 * - `file_changed` from each `Edit` / `Write` / `NotebookEdit` tool use.
 * - `decision_recorded` from each `AskUserQuestion` tool use, but ONLY when the
 *   recorded answer is a confirmed SELECTION — it exactly matches an option the
 *   question offered (`input.questions[].options[].label`). One decision per
 *   such question, titled `<question> -> <chosen answer>`. The answer is read
 *   from the paired result record's `toolUseResult.answers` map; a question with
 *   no recorded answer, or a free-text "Other" reply that matches no offered
 *   label, is skipped (it is not a decision, and would otherwise pollute
 *   decisions.md / orientation's latest-decision surface).
 *
 * Exit codes and per-command durations are not present in the transcript, so
 * `command_executed.exit_code` is `null` and `duration_ms` is `0`.
 *
 * Returns `null` when the transcript has no timestamped records, or no
 * observable command / file / decision action — such sessions carry no
 * provenance worth importing and are skipped by the caller.
 *
 * Event `id` / `session_id` are placeholders; `importSessionFromJson` mints
 * fresh ids on the way in. They are valid-by-construction so the payload
 * still passes `SessionImportPayloadSchema` validation upstream.
 */
export function claudeTranscriptToImportPayload(
  records: ReadonlyArray<ClaudeTranscriptRecord>,
  options: ClaudeTranscriptToPayloadOptions,
): SessionImportPayload | null {
  const placeholderSessionId = prefixedUlid("ses");
  // AskUserQuestion answers live on the *result* record, which arrives after
  // the originating tool_use; pre-index them so decisions can be derived at the
  // tool_use site in the single forward pass below.
  const askAnswers = indexAskAnswers(records);
  const derived: Event[] = [];
  const relatedFiles = new Set<string>();
  // Real transcripts are NOT strictly ordered by timestamp on disk
  // (sidechains and async writes interleave), so file order cannot be
  // trusted. Track the earliest / latest timestamp explicitly, and order the
  // derived events by occurred_at below.
  let minTs: string | undefined;
  let maxTs: string | undefined;
  let workingDir: string | undefined;
  let claudeSessionId: string | undefined;
  // Model-usage rollup: the transcript carries per-assistant-message token
  // usage; sum it into a session total (see metrics on the payload below).
  let outputTokens = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  // A single assistant message is split across multiple records (thinking /
  // text / tool_use), each carrying the SAME message.id and the SAME usage.
  // Count usage once per message.id to avoid multiplying the token totals.
  const seenMessageIds = new Set<string>();
  // Genuine engagement timestamps for the billing-oriented active-time metric:
  // real human prompts and assistant messages (action tool uses live inside
  // assistant messages, so they are subsumed). Sub-agent sidechains and
  // tool-result / meta records are excluded so autonomous loops and noise do
  // not inflate billable time. Assistant messages are counted once per
  // message.id, matching the token dedup above.
  const engagementTsMs: number[] = [];
  const seenEngagementMessageIds = new Set<string>();

  for (const record of records) {
    const ts = readString(record.timestamp);
    if (ts === undefined) continue;
    if (minTs === undefined || Date.parse(ts) < Date.parse(minTs)) minTs = ts;
    if (maxTs === undefined || Date.parse(ts) > Date.parse(maxTs)) maxTs = ts;
    if (workingDir === undefined) workingDir = readString(record.cwd);
    if (claudeSessionId === undefined) claudeSessionId = readString(record.sessionId);

    if (record.isSidechain !== true) {
      const tsMs = Date.parse(ts);
      if (Number.isFinite(tsMs)) {
        const recType = readString(record.type);
        if (recType === "user") {
          if (isHumanUserMessage(record)) engagementTsMs.push(tsMs);
        } else if (recType === "assistant") {
          const msg = isObject(record.message) ? record.message : undefined;
          const mid = msg !== undefined ? readString(msg.id) : undefined;
          if (mid === undefined || !seenEngagementMessageIds.has(mid)) {
            if (mid !== undefined) seenEngagementMessageIds.add(mid);
            engagementTsMs.push(tsMs);
          }
        }
      }
    }

    if (readString(record.type) !== "assistant") continue;

    const message = isObject(record.message) ? record.message : undefined;
    const usage = message !== undefined && isObject(message.usage) ? message.usage : undefined;
    if (usage !== undefined) {
      // Dedup by message.id; records without an id are counted individually.
      const messageId = message !== undefined ? readString(message.id) : undefined;
      const alreadyCounted = messageId !== undefined && seenMessageIds.has(messageId);
      if (!alreadyCounted) {
        if (messageId !== undefined) seenMessageIds.add(messageId);
        outputTokens += readNonNegInt(usage.output_tokens);
        inputTokens += readNonNegInt(usage.input_tokens);
        cachedInputTokens += readNonNegInt(usage.cache_read_input_tokens);
      }
    }

    const cwd = readString(record.cwd) ?? workingDir ?? ".";
    for (const item of toolUses(record)) {
      const name = readString(item.name);
      const input = isObject(item.input) ? item.input : undefined;
      if (input === undefined) continue;

      if (name === "Bash") {
        const command = readString(input.command);
        if (command !== undefined) {
          derived.push(commandExecutedEvent(ts, placeholderSessionId, command, cwd));
        }
        continue;
      }

      if (name === "AskUserQuestion") {
        const useId = readString(item.id);
        const answers = useId !== undefined ? askAnswers.get(useId) : undefined;
        if (answers !== undefined) {
          // Only a CONFIRMED selection becomes a decision: derive one only when
          // the recorded answer matches an option this question OFFERED. A
          // free-text "Other" reply (a counter-question, guidance, or other
          // meta answer) matches no offered label and is NOT a decision —
          // deriving one would pollute decisions.md and, worse, surface a
          // non-decision as orientation's latest-decision line. A genuine free-text
          // choice can still be recorded explicitly via `basou decision capture`.
          // One decision per question; Object.entries keeps insertion order for
          // string keys, and the stable sort below keeps it among same-ts events.
          const offeredByQuestion = readOfferedOptions(input);
          for (const [question, answer] of Object.entries(answers)) {
            if (question.length === 0) continue;
            const answerStr = typeof answer === "string" && answer.length > 0 ? answer : undefined;
            if (answerStr === undefined) continue;
            // Only an EXACT match of an offered option label is a confirmed
            // selection. A free-text "Other" reply (counter-question / guidance /
            // meta) matches nothing and is dropped. Multi-select answers (whose
            // serialization is undocumented) are deliberately NOT auto-derived
            // rather than risk mistaking a meta reply that happens to list
            // label-like words for a real selection — `basou decision capture`
            // remains the explicit path for anything not auto-derived.
            const offered = offeredByQuestion.get(question);
            if (offered === undefined || !offered.has(answerStr.trim())) continue;
            derived.push(
              decisionRecordedEvent(ts, placeholderSessionId, `${question} -> ${answerStr}`),
            );
          }
        }
        continue;
      }

      if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
        const path = readString(input.file_path) ?? readString(input.notebook_path);
        if (path !== undefined) {
          // Edit / NotebookEdit mutate an existing file; Write is treated as a
          // creation. The transcript does not reliably distinguish a Write
          // that overwrites, so "added" is the conservative default.
          const changeType = name === "Write" ? "added" : "modified";
          relatedFiles.add(path);
          derived.push(fileChangedEvent(ts, placeholderSessionId, path, changeType));
        }
      }
    }
  }

  if (minTs === undefined || maxTs === undefined) return null;
  if (derived.length === 0) return null;

  // Order derived events by occurred_at so the assembled stream is
  // non-decreasing — importSessionFromJson rejects out-of-order events.
  // Array.prototype.sort is stable, so same-timestamp events keep their
  // transcript order.
  derived.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));

  const events: Event[] = [
    sessionStartedEvent(minTs, placeholderSessionId),
    ...derived,
    sessionEndedEvent(maxTs, placeholderSessionId),
  ];

  const externalId = options.externalId ?? claudeSessionId;
  // Human-readable label: when + how much, so the session reads as content in
  // `basou session list` / handoff rather than an opaque id. The source id is
  // kept structurally in `source.external_id` (not the label), and paths are
  // deliberately excluded — the label is NOT path-sanitized downstream, so a
  // raw file path here would leak an operator-private prefix.
  const commandCount = derived.reduce((n, e) => (e.type === "command_executed" ? n + 1 : n), 0);
  const fileCount = relatedFiles.size;
  const label = `claude-code ${sessionLabelDateSpan(minTs, maxTs)}: ${commandCount} ${commandCount === 1 ? "command" : "commands"}, ${fileCount} ${fileCount === 1 ? "file" : "files"}`;

  // Engaged-active time from the genuine engagement series (needs >= 2 points
  // to bound any gap); omitted when too sparse so stats falls back to the
  // event-derived measure.
  const active =
    engagementTsMs.length >= 2
      ? activeTimeFromTimestamps(engagementTsMs, ACTIVE_GAP_CAP_MS)
      : undefined;

  // Only include fields actually present; omit metrics entirely for a
  // transcript that carried neither token usage nor an engaged-time signal.
  const metricsFields = {
    ...(outputTokens > 0 ? { output_tokens: outputTokens } : {}),
    ...(inputTokens > 0 ? { input_tokens: inputTokens } : {}),
    ...(cachedInputTokens > 0 ? { cached_input_tokens: cachedInputTokens } : {}),
    ...(active !== undefined && active.ms > 0
      ? {
          active_time_ms: active.ms,
          active_intervals: intervalsMsToIso(active.intervals),
          active_gap_cap_ms: ACTIVE_GAP_CAP_MS,
          active_time_method: ENGAGED_TURNS_METHOD,
        }
      : {}),
  };
  const metrics = Object.keys(metricsFields).length > 0 ? metricsFields : undefined;

  const payload: SessionImportPayload = {
    schema_version: "0.1.0",
    session: {
      label,
      workspace_id: options.workspaceId,
      source: {
        kind: CLAUDE_IMPORT_SOURCE,
        version: "0.1.0",
        ...(externalId !== undefined ? { external_id: externalId } : {}),
        ...(options.sourceSizeBytes !== undefined
          ? { source_size_bytes: options.sourceSizeBytes }
          : {}),
      },
      started_at: minTs,
      ended_at: maxTs,
      // Validated against the canonical enum here; importSessionFromJson
      // overwrites it with the literal "imported" regardless.
      status: "imported",
      working_directory: workingDir ?? ".",
      invocation: { command: "claude", args: [], exit_code: null },
      related_files: [...relatedFiles].sort(),
      summary: null,
      ...(metrics !== undefined ? { metrics } : {}),
    },
    events,
  };
  return payload;
}

// --- event builders -------------------------------------------------------

function baseEvent(
  occurredAt: string,
  sessionId: PrefixedId<"ses">,
): {
  schema_version: "0.1.0";
  id: PrefixedId<"evt">;
  session_id: PrefixedId<"ses">;
  occurred_at: string;
  source: string;
} {
  return {
    schema_version: "0.1.0",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: CLAUDE_IMPORT_SOURCE,
  };
}

function sessionStartedEvent(occurredAt: string, sessionId: PrefixedId<"ses">): Event {
  return { ...baseEvent(occurredAt, sessionId), type: "session_started" };
}

function sessionEndedEvent(occurredAt: string, sessionId: PrefixedId<"ses">): Event {
  return { ...baseEvent(occurredAt, sessionId), type: "session_ended" };
}

function commandExecutedEvent(
  occurredAt: string,
  sessionId: PrefixedId<"ses">,
  command: string,
  cwd: string,
): Event {
  return {
    ...baseEvent(occurredAt, sessionId),
    type: "command_executed",
    command: "bash",
    args: ["-c", command],
    cwd,
    exit_code: null,
    duration_ms: 0,
  };
}

function fileChangedEvent(
  occurredAt: string,
  sessionId: PrefixedId<"ses">,
  path: string,
  changeType: "added" | "modified",
): Event {
  return {
    ...baseEvent(occurredAt, sessionId),
    type: "file_changed",
    path,
    change_type: changeType,
  };
}

function decisionRecordedEvent(
  occurredAt: string,
  sessionId: PrefixedId<"ses">,
  title: string,
): Event {
  return {
    ...baseEvent(occurredAt, sessionId),
    type: "decision_recorded",
    decision_id: prefixedUlid("decision"),
    title,
  };
}

// --- defensive readers ----------------------------------------------------

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a non-negative integer token count, treating anything else as 0. */
function readNonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `user` record is a genuine human prompt when its message content is a
 * non-empty string, or an array containing at least one non-`tool_result`
 * block (e.g. text / image). A record whose content is only `tool_result`
 * blocks is the assistant's tool-feedback loop, not human input, and is
 * excluded from the engagement series.
 */
function isHumanUserMessage(record: ClaudeTranscriptRecord): boolean {
  const message = isObject(record.message) ? record.message : undefined;
  if (message === undefined) return false;
  const content = message.content;
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (!isObject(block)) return false;
      const type = readString(block.type);
      return type !== undefined && type !== "tool_result";
    });
  }
  return false;
}

/**
 * Extract the `tool_use` items from an assistant record's
 * `message.content[]`. Returns an empty array for any record that does not
 * match the expected nesting, so callers can iterate unconditionally.
 */
function toolUses(record: ClaudeTranscriptRecord): Array<Record<string, unknown>> {
  const message = isObject(record.message) ? record.message : undefined;
  const content = message !== undefined && Array.isArray(message.content) ? message.content : [];
  const result: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (isObject(item) && readString(item.type) === "tool_use") {
      result.push(item);
    }
  }
  return result;
}
