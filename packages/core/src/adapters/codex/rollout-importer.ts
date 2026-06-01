import { type PrefixedId, prefixedUlid } from "../../ids/ulid.js";
import type { Event } from "../../schemas/event.schema.js";
import type { Manifest } from "../../schemas/manifest.schema.js";
import type { SessionImportPayload } from "../../schemas/session-import.schema.js";

/**
 * The `source` string stamped on every event derived from an OpenAI Codex
 * native rollout log, and the matching session `source.kind`.
 */
export const CODEX_IMPORT_SOURCE = "codex-import";

/**
 * One parsed line of a Codex rollout log
 * (`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`). Each line is an
 * envelope `{ type, timestamp, payload }` where `payload` shape depends on
 * `type`. As with the Claude importer the format is the vendor's internal
 * log, not Basou's schema, so every field is read defensively — unknown
 * record / payload types and missing fields are skipped rather than rejected.
 */
export type CodexRolloutRecord = Record<string, unknown>;

/** Options for {@link codexRolloutToImportPayload}. */
export type CodexRolloutToPayloadOptions = {
  /** Workspace id of the target Basou workspace (from its manifest). */
  workspaceId: Manifest["workspace"]["id"];
  /**
   * Codex session id (`session_meta.payload.id`). Stored as
   * `session.source.external_id` so re-imports can be deduplicated. Falls back
   * to the id read from the rollout's `session_meta` record when omitted.
   */
  externalId?: string;
};

/**
 * Transform a Codex native rollout log into a Basou {@link SessionImportPayload},
 * ready to hand to `importSessionFromJson`.
 *
 * This is a pure function: no disk or environment access. It DERIVES Basou's
 * provenance-level events from the rollout's message-level records:
 *
 * - `session_started` / `session_ended` from the first / last timestamped record.
 * - `command_executed` from each `exec_command` function call, recorded as
 *   `bash -c "<cmd>"`. The shell line and working directory come from the
 *   call's JSON `arguments` (`{ cmd, workdir }`); the exit code and duration
 *   are parsed from the paired `function_call_output` (matched by `call_id`),
 *   whose text carries `Process exited with code N` and `Wall time: X seconds`.
 *
 * Unlike the Claude importer this derives no `file_changed`: Codex has no
 * dedicated edit tool and applies edits inside `exec_command` (e.g.
 * `apply_patch`), so there is no clean file-change signal to map. Decisions
 * and approvals are likewise not derivable — Codex records an `approval_policy`
 * (a policy, not a per-action approval) and has no structured question/answer
 * record. Both are deferred.
 *
 * Returns `null` when the rollout has no timestamped records or no observable
 * `exec_command` — such sessions carry no provenance worth importing and are
 * skipped by the caller.
 *
 * Event `id` / `session_id` are placeholders; `importSessionFromJson` mints
 * fresh ids on the way in. They are valid-by-construction so the payload still
 * passes `SessionImportPayloadSchema` validation upstream.
 */
export function codexRolloutToImportPayload(
  records: ReadonlyArray<CodexRolloutRecord>,
  options: CodexRolloutToPayloadOptions,
): SessionImportPayload | null {
  const placeholderSessionId = prefixedUlid("ses");
  // A command's exit code and duration live on its `function_call_output`,
  // which arrives after the originating `function_call`; pre-index outputs by
  // call_id so commands can be completed in the single forward pass below.
  const outputsByCallId = indexOutputs(records);
  const derived: Event[] = [];
  // Real rollouts are written in arrival order, but track the earliest /
  // latest timestamp explicitly (rather than trusting first / last line) and
  // order the derived events by occurred_at below, mirroring the Claude path.
  let minTs: string | undefined;
  let maxTs: string | undefined;
  let workingDir: string | undefined;
  let codexSessionId: string | undefined;
  // Codex emits cumulative token_count events; the last one's
  // total_token_usage is the session total (see metrics on the payload below).
  let lastTokenTotals: Record<string, unknown> | undefined;

  for (const record of records) {
    const ts = readString(record.timestamp);
    if (ts === undefined) continue;
    if (minTs === undefined || Date.parse(ts) < Date.parse(minTs)) minTs = ts;
    if (maxTs === undefined || Date.parse(ts) > Date.parse(maxTs)) maxTs = ts;

    const payload = isObject(record.payload) ? record.payload : undefined;
    if (payload === undefined) continue;

    if (readString(record.type) === "session_meta") {
      // The session-level cwd and id are the most reliable working directory
      // and dedup key; take the first occurrence and keep it.
      if (workingDir === undefined) workingDir = readString(payload.cwd);
      if (codexSessionId === undefined) codexSessionId = readString(payload.id);
      continue;
    }

    if (readString(record.type) === "event_msg" && readString(payload.type) === "token_count") {
      const info = isObject(payload.info) ? payload.info : undefined;
      const totals =
        info !== undefined && isObject(info.total_token_usage) ? info.total_token_usage : undefined;
      // Cumulative; keep the latest so the final value is the session total.
      if (totals !== undefined) lastTokenTotals = totals;
      continue;
    }

    if (readString(record.type) !== "response_item") continue;
    if (readString(payload.type) !== "function_call") continue;
    if (readString(payload.name) !== "exec_command") continue;

    const command = readExecCommand(payload.arguments);
    if (command === undefined) continue;
    const cwd = command.workdir ?? workingDir ?? ".";
    const output = readCallId(payload.call_id, outputsByCallId);
    derived.push(
      commandExecutedEvent(ts, placeholderSessionId, command.cmd, cwd, {
        exitCode: parseExitCode(output),
        durationMs: parseWallTimeMs(output),
      }),
    );
  }

  if (minTs === undefined || maxTs === undefined) return null;
  if (derived.length === 0) return null;

  // Order derived events by occurred_at so the assembled stream is
  // non-decreasing — importSessionFromJson rejects out-of-order events.
  // Array.prototype.sort is stable, so same-timestamp events keep their
  // rollout order.
  derived.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));

  const events: Event[] = [
    sessionStartedEvent(minTs, placeholderSessionId),
    ...derived,
    sessionEndedEvent(maxTs, placeholderSessionId),
  ];

  const externalId = options.externalId ?? codexSessionId;
  // Human-readable label: when + how much, so the session reads as content in
  // `basou session list` / handoff rather than an opaque id. The source id is
  // kept structurally in `source.external_id` (not the label), and paths are
  // deliberately excluded — the label is NOT path-sanitized downstream, so a
  // raw file path here would leak an operator-private prefix.
  const commandCount = derived.length;
  const date = minTs.slice(0, 10);
  const label = `codex ${date}: ${commandCount} ${commandCount === 1 ? "command" : "commands"}`;

  // Token totals from the last cumulative token_count event; include only the
  // fields actually present (> 0), omitting metrics entirely if none.
  const metricsFields =
    lastTokenTotals === undefined
      ? {}
      : {
          ...(readNonNegInt(lastTokenTotals.output_tokens) > 0
            ? { output_tokens: readNonNegInt(lastTokenTotals.output_tokens) }
            : {}),
          ...(readNonNegInt(lastTokenTotals.input_tokens) > 0
            ? { input_tokens: readNonNegInt(lastTokenTotals.input_tokens) }
            : {}),
          ...(readNonNegInt(lastTokenTotals.cached_input_tokens) > 0
            ? { cached_input_tokens: readNonNegInt(lastTokenTotals.cached_input_tokens) }
            : {}),
          ...(readNonNegInt(lastTokenTotals.reasoning_output_tokens) > 0
            ? { reasoning_output_tokens: readNonNegInt(lastTokenTotals.reasoning_output_tokens) }
            : {}),
        };
  const metrics = Object.keys(metricsFields).length > 0 ? metricsFields : undefined;

  const payload: SessionImportPayload = {
    schema_version: "0.1.0",
    session: {
      label,
      workspace_id: options.workspaceId,
      source: {
        kind: CODEX_IMPORT_SOURCE,
        version: "0.1.0",
        ...(externalId !== undefined ? { external_id: externalId } : {}),
      },
      started_at: minTs,
      ended_at: maxTs,
      // Validated against the canonical enum here; importSessionFromJson
      // overwrites it with the literal "imported" regardless.
      status: "imported",
      working_directory: workingDir ?? ".",
      invocation: { command: "codex", args: [], exit_code: null },
      related_files: [],
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
    source: CODEX_IMPORT_SOURCE,
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
  outcome: { exitCode: number | null; durationMs: number },
): Event {
  return {
    ...baseEvent(occurredAt, sessionId),
    type: "command_executed",
    command: "bash",
    args: ["-c", command],
    cwd,
    exit_code: outcome.exitCode,
    duration_ms: outcome.durationMs,
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
 * Parse an `exec_command` call's JSON `arguments` string into its shell line
 * and optional working directory. Returns `undefined` when the arguments are
 * not parseable or carry no `cmd`, so the caller can skip the call.
 */
function readExecCommand(value: unknown): { cmd: string; workdir: string | undefined } | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const cmd = readString(parsed.cmd);
  if (cmd === undefined) return undefined;
  return { cmd, workdir: readString(parsed.workdir) };
}

function readCallId(value: unknown, outputs: ReadonlyMap<string, string>): string | undefined {
  const callId = readString(value);
  return callId !== undefined ? outputs.get(callId) : undefined;
}

/**
 * Codex's `exec_command` output text reports the child's exit code as
 * `Process exited with code N` (N may be negative for signal termination).
 * Returns `null` when the line is absent — the command may have yielded before
 * completing or the session was cut off mid-command.
 */
function parseExitCode(output: string | undefined): number | null {
  if (output === undefined) return null;
  const match = output.match(/Process exited with code (-?\d+)/);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : null;
}

/**
 * Codex's `exec_command` output text reports wall-clock duration as
 * `Wall time: X seconds`. Returns `0` (the schema floor) when absent or
 * non-finite, matching the Claude importer's missing-duration default.
 */
function parseWallTimeMs(output: string | undefined): number {
  if (output === undefined) return 0;
  const match = output.match(/Wall time:\s*([\d.]+)\s*seconds/);
  if (match?.[1] === undefined) return 0;
  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * Index every `function_call_output`'s text by its `call_id`, so a command's
 * exit code and duration can be looked up at the originating `function_call`.
 * Only string outputs are kept — image / structured tool results are arrays
 * and carry no command outcome.
 */
function indexOutputs(records: ReadonlyArray<CodexRolloutRecord>): Map<string, string> {
  const byId = new Map<string, string>();
  for (const record of records) {
    if (readString(record.type) !== "response_item") continue;
    const payload = isObject(record.payload) ? record.payload : undefined;
    if (payload === undefined) continue;
    if (readString(payload.type) !== "function_call_output") continue;
    const callId = readString(payload.call_id);
    const output = readString(payload.output);
    if (callId !== undefined && output !== undefined) byId.set(callId, output);
  }
  return byId;
}
