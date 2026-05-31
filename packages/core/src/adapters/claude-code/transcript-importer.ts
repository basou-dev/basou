import { type PrefixedId, prefixedUlid } from "../../ids/ulid.js";
import type { Event } from "../../schemas/event.schema.js";
import type { Manifest } from "../../schemas/manifest.schema.js";
import type { SessionImportPayload } from "../../schemas/session-import.schema.js";

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
 *
 * Exit codes and per-command durations are not present in the transcript, so
 * `command_executed.exit_code` is `null` and `duration_ms` is `0`.
 *
 * Returns `null` when the transcript has no timestamped records, or no
 * observable command / file action — such sessions carry no provenance worth
 * importing and are skipped by the caller.
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

  for (const record of records) {
    const ts = readString(record.timestamp);
    if (ts === undefined) continue;
    if (minTs === undefined || Date.parse(ts) < Date.parse(minTs)) minTs = ts;
    if (maxTs === undefined || Date.parse(ts) > Date.parse(maxTs)) maxTs = ts;
    if (workingDir === undefined) workingDir = readString(record.cwd);
    if (claudeSessionId === undefined) claudeSessionId = readString(record.sessionId);

    if (readString(record.type) !== "assistant") continue;
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
  const label =
    externalId !== undefined ? `claude-code import ${externalId}` : "claude-code import";

  const payload: SessionImportPayload = {
    schema_version: "0.1.0",
    session: {
      label,
      workspace_id: options.workspaceId,
      source: {
        kind: CLAUDE_IMPORT_SOURCE,
        version: "0.1.0",
        ...(externalId !== undefined ? { external_id: externalId } : {}),
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

// --- defensive readers ----------------------------------------------------

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
