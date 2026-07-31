import { type PrefixedId, prefixedUlid } from "../../ids/ulid.js";
import type { Event } from "../../schemas/event.schema.js";
import type { Manifest } from "../../schemas/manifest.schema.js";
import type { SessionImportPayload } from "../../schemas/session-import.schema.js";
import {
  ACTIVE_GAP_CAP_MS,
  activeTimeFromTimestamps,
  ENGAGED_TURNS_METHOD,
  type IntervalMs,
  intervalsMsToIso,
  TURN_INTERVALS_METHOD,
  unionDurationMs,
} from "../../stats/active-time.js";
import { sessionLabelDateSpan } from "../session-label.js";

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
  /**
   * Byte size of the source rollout that produced `records`, stored as
   * `session.source.source_size_bytes` so a later import can detect growth and
   * re-import the session. The caller passes the size of the buffer it actually
   * read (an immutable snapshot of the parsed bytes), so the stored size always
   * matches the imported content. Omitted => the field is not recorded.
   */
  sourceSizeBytes?: number;
};

/**
 * Transform a Codex native rollout log into a Basou {@link SessionImportPayload},
 * ready to hand to `importSessionFromJson`.
 *
 * This is a pure function: no disk or environment access. It DERIVES Basou's
 * provenance-level events from the rollout's message-level records:
 *
 * - `session_started` / `session_ended` from the first / last timestamped record.
 * - `command_executed` from each shell execution, recorded as `bash -c "<cmd>"`.
 *   Codex has written these two different ways, and BOTH are read (an operator's
 *   `~/.codex/sessions` holds a mix across a CLI upgrade):
 *     - one `function_call` named `exec_command` per command, with JSON
 *       `arguments` (`{ cmd, workdir }`) and a `function_call_output` whose text
 *       carries `Process exited with code N` / `Wall time: X seconds`;
 *     - a scripted `custom_tool_call` (see
 *       {@link readExecCommandsFromScript}) whose `input` is a JS program that
 *       calls `tools.exec_command({ cmd, workdir })` — possibly several times in
 *       one call — and whose output reports only `Wall time X seconds` for the
 *       whole script, with no per-command exit code.
 *   Reading only the first shape made every session recorded by a CLI that had
 *   moved to the second derive ZERO commands, so the whole session was dropped
 *   as "no actions" — capture went silently blind rather than degrading.
 *
 * Per-session `metrics` are also derived: token totals from the cumulative
 * `token_count` events; active time from the real `task_started` ->
 * `task_complete` turn spans (in-turn, uncapped) unioned with the gap-capped
 * engagement series (between-turn bridging), labeled `turn-intervals`; and
 * `machine_active_time_ms` from the summed `task_complete.duration_ms` (model
 * compute time, a subset of active time).
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
  // A turn's start lives on its `task_started`; pair it with the matching
  // `task_complete` by turn_id so each turn yields a real wall-clock interval.
  // Pre-indexed (rather than matched inline) so it is robust to record order.
  const turnStartMsByTurnId = indexTaskStarts(records);
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
  // Genuine engagement timestamps for the billing-oriented active-time metric:
  // conversation turns (user / agent messages and task boundaries) plus the
  // exec_command actions. Token-count heartbeats, reasoning, web-search and
  // tool-output records are excluded so they cannot inflate billable time.
  // These bridge BETWEEN turns (gap-capped); within a turn the explicit
  // task interval below supersedes them on merge.
  const engagementTsMs: number[] = [];
  // Real per-turn wall-clock spans (`task_started` -> `task_complete`). Used
  // for the in-turn portion of active time (uncapped, and crediting the final
  // turn), unioned with the gap-capped engagement series above.
  // One per (deduped) `task_complete`: the turn's wall-clock interval and its
  // reported model-compute duration. Resolved into active time + machine time
  // after the loop, once `minTs` is known (so a reconstructed start can be
  // clamped to the session floor). `durationMs` is 0 when the rollout records
  // none (older format).
  const completions: Array<{ interval: IntervalMs | undefined; durationMs: number }> = [];
  // De-dup completions by turn_id: a duplicate `task_complete` for the same
  // turn would double-count machine time (breaking machine <= active) while the
  // union-merged interval counts the turn once. First completion per turn wins.
  const completedTurnIds = new Set<string>();

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

    if (readString(record.type) === "event_msg") {
      const pt = readString(payload.type);
      if (
        pt === "user_message" ||
        pt === "agent_message" ||
        pt === "task_started" ||
        pt === "task_complete"
      ) {
        const tsMs = Date.parse(ts);
        if (Number.isFinite(tsMs)) engagementTsMs.push(tsMs);
      }
      if (pt === "task_complete") {
        const turnId = readString(payload.turn_id);
        // Skip a duplicate completion for an already-counted turn (F1).
        if (turnId === undefined || !completedTurnIds.has(turnId)) {
          if (turnId !== undefined) completedTurnIds.add(turnId);
          completions.push({
            interval: turnIntervalFromComplete(ts, payload, turnStartMsByTurnId),
            durationMs: readNonNegInt(payload.duration_ms),
          });
        }
      }
      // event_msg records are never response_items; skip the rest.
      continue;
    }

    if (readString(record.type) !== "response_item") continue;

    // Scripted tool call: one call can carry several `tools.exec_command(...)`
    // invocations. Only the SCRIPT tool's input is scanned as a program — other
    // custom tools share this envelope (`apply_patch` carries a patch body,
    // which can legitimately CONTAIN the text of an exec call) and scanning
    // those would fabricate commands that never ran. If the vendor renames the
    // script tool, this fails closed to "no actions", which `basou refresh` now
    // reports rather than hiding.
    if (readString(payload.type) === "custom_tool_call") {
      if (readString(payload.name) !== SCRIPT_TOOL_NAME) continue;
      const scan = scanScript(readString(payload.input));
      if (scan.commands.length === 0) continue;
      const output = readCallId(payload.call_id, outputsByCallId);
      // The output reports ONE wall time for the whole program, so it is only
      // honest as a command duration when that program did exactly one thing:
      // a script that also searched the web or updated a plan would credit the
      // command with time it did not spend. Anything else falls back to the
      // schema floor (0 = unrecorded).
      const durationMs = scan.toolCallCount === 1 ? parseWallTimeMs(output) : 0;
      const scriptTsMs = Date.parse(ts);
      if (Number.isFinite(scriptTsMs)) engagementTsMs.push(scriptTsMs);
      for (const command of scan.commands) {
        derived.push(
          // The per-command exit code is absent from this format (the script
          // would have to print it), so it stays null — "unknown", not "0".
          commandExecutedEvent(
            ts,
            placeholderSessionId,
            command.cmd,
            command.workdir ?? workingDir ?? ".",
            {
              exitCode: null,
              durationMs,
            },
          ),
        );
      }
      continue;
    }

    if (readString(payload.type) !== "function_call") continue;
    if (readString(payload.name) !== "exec_command") continue;

    const command = readExecCommand(payload.arguments);
    if (command === undefined) continue;
    const cwd = command.workdir ?? workingDir ?? ".";
    const output = readCallId(payload.call_id, outputsByCallId);
    const execTsMs = Date.parse(ts);
    if (Number.isFinite(execTsMs)) engagementTsMs.push(execTsMs);
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
  const label = `codex ${sessionLabelDateSpan(minTs, maxTs)}: ${commandCount} ${commandCount === 1 ? "command" : "commands"}`;

  // Resolve per-turn intervals + machine compute now that `minTs` is known.
  // A turn whose `task_started` is absent has its start reconstructed as
  // `end - duration_ms`, which can precede the earliest record (and thus
  // `started_at`); clamp to `minTs` so no active interval predates the session
  // (F3). Machine compute for each turn is bounded by its clamped in-session
  // span, so a clamped turn can never push the session's machine time above its
  // active time (the documented `machine <= active` subset; F1). For ordinary
  // fully-logged turns the span is >= the reported duration, so this is exactly
  // `duration_ms`. `machine` is honest only when EVERY completed turn carried a
  // duration: a mix of duration-bearing and duration-less completions would
  // report a partial compute total as if complete, so it is omitted then (F2).
  const minTsMs = Date.parse(minTs);
  const turnIntervals: IntervalMs[] = [];
  let machineActiveMs = 0;
  let allCompletedTurnsHaveDuration = true;
  for (const { interval, durationMs } of completions) {
    if (durationMs <= 0) allCompletedTurnsHaveDuration = false;
    if (interval === undefined) continue;
    const start = Number.isFinite(minTsMs) ? Math.max(interval[0], minTsMs) : interval[0];
    const end = interval[1];
    if (!(start < end)) continue;
    turnIntervals.push([start, end]);
    machineActiveMs += Math.min(durationMs, end - start);
  }

  // Active time = union of the real per-turn intervals (in-turn, uncapped) and
  // the gap-capped engagement series (between-turn bridging). The merge dedups
  // their overlap, so the in-turn portion is the turn span while between-turn
  // human time is still credited up to the cap. A single explicit turn is
  // enough to bound active time, so the >= 2-point fallback only matters when
  // no turn intervals exist. Omitted when neither yields a span, so stats falls
  // back to the event-derived measure. Method label reflects which was used.
  const pointResult = activeTimeFromTimestamps(engagementTsMs, ACTIVE_GAP_CAP_MS);
  const active =
    turnIntervals.length > 0 || pointResult.intervals.length > 0
      ? unionDurationMs([...turnIntervals, ...pointResult.intervals])
      : undefined;
  const activeMethod = turnIntervals.length > 0 ? TURN_INTERVALS_METHOD : ENGAGED_TURNS_METHOD;
  const machineActive = allCompletedTurnsHaveDuration ? machineActiveMs : 0;

  // Token totals from the last cumulative token_count event; include only the
  // fields actually present (> 0). Metrics is emitted if either token usage or
  // an engaged-time signal is present.
  const tokenFields =
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
  const metricsFields = {
    ...tokenFields,
    ...(active !== undefined && active.ms > 0
      ? {
          active_time_ms: active.ms,
          active_intervals: intervalsMsToIso(active.merged),
          active_gap_cap_ms: ACTIVE_GAP_CAP_MS,
          active_time_method: activeMethod,
        }
      : {}),
    ...(machineActive > 0 ? { machine_active_time_ms: machineActive } : {}),
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

/** Name of the custom tool whose `input` is a script (vs `apply_patch` etc.). */
const SCRIPT_TOOL_NAME = "exec";

/** Prefix of every tool call in a script; `tools.<name>(`. */
const TOOL_CALL_PREFIX = "tools.";

/** The scripted tool that runs a shell command. */
const EXEC_TOOL = "exec_command";

/** One shell execution read out of a script. */
type ScriptedCommand = { cmd: string; workdir: string | undefined };

/** What a script was found to do: its resolvable commands and how many tools it called at all. */
type ScriptScan = {
  commands: ScriptedCommand[];
  /** Every `tools.<name>(` call site found at code level, exec or not. */
  toolCallCount: number;
};

/**
 * Scan a scripted tool call's `input` — a JS program such as
 * `const r = await tools.exec_command({cmd:"…", workdir:"…"})`, sometimes running
 * several commands (e.g. inside `Promise.all([...])`) — and return every shell
 * execution it can resolve, in script order, plus the total number of tool calls
 * it makes (which tells the caller whether a single script-level wall time can
 * honestly be attributed to one command).
 *
 * The script is SCANNED, never evaluated, and the scan is at CODE level: string
 * literals, template literals and both comment forms are skipped, so a call site
 * that appears inside a heredoc, a patch body, a quoted example or a commented-out
 * line is not mistaken for a command that ran. That mistake would fabricate
 * provenance, which is worse than missing a command.
 *
 * Values are read only when they are plainly readable, because resolving anything
 * else would mean running the script. A call is SKIPPED (not guessed) when `cmd`
 * is passed by variable or shorthand (`{ cmd }`, `{ cmd: line }`), built by an
 * expression (`{ cmd: "git " + verb }`), overridden by a spread (`{ cmd: "…",
 * ...opts }` — where JS, not the text, decides), or given twice. An interpolation
 * inside a template literal (`${…}`) is kept verbatim: a visible placeholder is
 * more honest than inventing the value or dropping the evidence that a command ran.
 */
function scanScript(script: string | undefined): ScriptScan {
  const scan: ScriptScan = { commands: [], toolCallCount: 0 };
  if (script === undefined) return scan;
  let i = 0;
  while (i < script.length) {
    const skipped = skipNonCode(script, i);
    if (skipped !== i) {
      // Unterminated string / comment: nothing readable remains.
      if (skipped === -1) return scan;
      i = skipped;
      continue;
    }
    if (!script.startsWith(TOOL_CALL_PREFIX, i)) {
      i++;
      continue;
    }
    const nameStart = i + TOOL_CALL_PREFIX.length;
    const nameEnd = readIdentifierEnd(script, nameStart);
    const open = skipWhitespaceAndComments(script, nameEnd);
    if (nameEnd === nameStart || open === -1 || script[open] !== "(") {
      i = nameStart;
      continue;
    }
    scan.toolCallCount++;
    const argsStart = skipWhitespaceAndComments(script, open + 1);
    i = open + 1;
    if (argsStart === -1 || script[argsStart] !== "{") continue;
    const argsEnd = findObjectEnd(script, argsStart);
    if (argsEnd === -1) continue;
    i = argsEnd + 1;
    if (script.slice(nameStart, nameEnd) !== EXEC_TOOL) continue;
    const command = readExecArguments(script.slice(argsStart, argsEnd + 1));
    if (command !== undefined) scan.commands.push(command);
  }
  return scan;
}

/**
 * Index just past the string literal / comment starting at `at`, `at` itself when
 * that position is ordinary code, or -1 when the literal or block comment is
 * unterminated. Template literals consume their `${…}` substitutions whole, so a
 * tool call written inside one is treated as string content (skipped, per the
 * "resolve nothing" rule) rather than as a command that ran.
 */
function skipNonCode(script: string, at: number): number {
  const ch = script[at];
  if (ch === '"' || ch === "'" || ch === "`") return skipStringLiteral(script, at);
  if (ch !== "/") return at;
  const next = script[at + 1];
  if (next === "/") {
    const eol = script.indexOf("\n", at + 2);
    return eol === -1 ? script.length : eol + 1;
  }
  if (next === "*") {
    const end = script.indexOf("*/", at + 2);
    return end === -1 ? -1 : end + 2;
  }
  return at;
}

/** Index just past the string literal opening at `at`, or -1 when unterminated. */
function skipStringLiteral(script: string, at: number): number {
  const quote = script[at];
  for (let i = at + 1; i < script.length; i++) {
    const ch = script[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && script[i + 1] === "{") {
      const end = findObjectEnd(script, i + 1);
      if (end === -1) return -1;
      i = end;
    }
  }
  return -1;
}

/** Index just past a run of whitespace and comments, or -1 on an unterminated comment. */
function skipWhitespaceAndComments(script: string, at: number): number {
  let i = at;
  while (i < script.length) {
    if (/\s/.test(script[i] ?? "")) {
      i++;
      continue;
    }
    if (script[i] !== "/") return i;
    const skipped = skipNonCode(script, i);
    if (skipped === -1) return -1;
    if (skipped === i) return i;
    i = skipped;
  }
  return i;
}

/** Index just past an identifier (may be empty, in which case start is returned). */
function readIdentifierEnd(script: string, start: number): number {
  let i = start;
  while (i < script.length && /[A-Za-z0-9_$]/.test(script[i] ?? "")) i++;
  return i;
}

/**
 * Index of the `}` / `)` / `]` closing the bracket that opens at `start`, or -1
 * when it is unterminated. Strings and comments are skipped so a bracket inside a
 * shell command or a comment does not end the literal.
 */
function findObjectEnd(script: string, start: number): number {
  const closers: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  let i = start;
  while (i < script.length) {
    const skipped = skipNonCode(script, i);
    if (skipped === -1) return -1;
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = script[i] ?? "";
    const closer = closers[ch];
    if (closer !== undefined) {
      stack.push(closer);
    } else if (ch === "}" || ch === ")" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Read an exec call's argument object (the literal text, braces included) into
 * its shell line and optional working directory. Only top-level properties whose
 * value is a single string literal are read; see {@link scanScript} for the forms
 * that are deliberately skipped instead of guessed. Returns undefined when no
 * usable `cmd` can be read, so the caller skips the call.
 */
function readExecArguments(literal: string): ScriptedCommand | undefined {
  const values = new Map<string, string | undefined>();
  let i = 1; // past the opening brace
  while (i < literal.length) {
    const at = skipWhitespaceAndComments(literal, i);
    if (at === -1) return undefined;
    const ch = literal[at];
    if (ch === "}" || ch === undefined) break;
    if (ch === ",") {
      i = at + 1;
      continue;
    }
    // A spread hands the decision to JS: which value wins is not in the text.
    if (literal.startsWith("...", at)) return undefined;
    let key: string;
    let afterKey: number;
    if (ch === '"' || ch === "'") {
      const end = skipStringLiteral(literal, at);
      if (end === -1) return undefined;
      key = literal.slice(at + 1, end - 1);
      afterKey = end;
    } else {
      afterKey = readIdentifierEnd(literal, at);
      if (afterKey === at) return undefined; // unreadable property syntax
      key = literal.slice(at, afterKey);
    }
    const colon = skipWhitespaceAndComments(literal, afterKey);
    if (colon === -1) return undefined;
    if (literal[colon] !== ":") {
      // Shorthand (`{ cmd }`): the value lives in a variable, not the text.
      if (key === "cmd" || key === "workdir") return undefined;
      i = colon;
      const next = skipToPropertyEnd(literal, colon);
      if (next === -1) return undefined;
      i = next;
      continue;
    }
    const valueAt = skipWhitespaceAndComments(literal, colon + 1);
    if (valueAt === -1) return undefined;
    const valueChar = literal[valueAt];
    let value: string | undefined;
    let afterValue = valueAt;
    if (valueChar === '"' || valueChar === "'" || valueChar === "`") {
      const end = skipStringLiteral(literal, valueAt);
      if (end === -1) return undefined;
      const decoded = unescapeScriptString(literal.slice(valueAt, end));
      afterValue = end;
      // The literal must BE the value: `"git " + verb` continues into an
      // expression whose result is not in the text.
      const after = skipWhitespaceAndComments(literal, end);
      if (after === -1) return undefined;
      const terminator = literal[after];
      if (terminator === "," || terminator === "}") {
        value = decoded.length > 0 ? decoded : undefined;
        afterValue = after;
      } else if (key === "cmd" || key === "workdir") {
        return undefined;
      }
    } else if (key === "cmd" || key === "workdir") {
      return undefined; // a variable / expression / object: not resolvable
    }
    if (key === "cmd" || key === "workdir") {
      // Given twice, JS keeps the last; rather than pick, treat it as unresolvable.
      if (values.has(key)) return undefined;
      values.set(key, value);
    }
    const next = skipToPropertyEnd(literal, afterValue);
    if (next === -1) return undefined;
    i = next;
  }
  const cmd = values.get("cmd");
  if (cmd === undefined) return undefined;
  return { cmd, workdir: values.get("workdir") };
}

/** Index of the `,` or closing `}` that ends the property containing `at`, or -1. */
function skipToPropertyEnd(literal: string, at: number): number {
  let i = at;
  while (i < literal.length) {
    const skipped = skipNonCode(literal, i);
    if (skipped === -1) return -1;
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = literal[i];
    if (ch === "," || ch === "}") return i;
    if (ch === "{" || ch === "(" || ch === "[") {
      const end = findObjectEnd(literal, i);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    i++;
  }
  return -1;
}

/** Simple JS string escapes; anything else decodes to the character itself. */
const SCRIPT_STRING_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/**
 * Decode a JS string literal (quotes included) to the value it denotes.
 *
 * Nothing here may THROW: this runs on a vendor log line, and one malformed
 * escape must cost one skipped value, never the whole import. A code-point
 * escape that is out of range (`\u{110000}`) or malformed keeps its literal text
 * instead of being decoded.
 */
function unescapeScriptString(quoted: string): string {
  return quoted
    .slice(1, -1)
    .replace(
      /\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
      (match, sequence: string) => {
        // Single-character escapes first: a bare `\u` / `\x` that is NOT a valid
        // hex form reaches this branch, and must not be read as a code point.
        if (sequence.length === 1) {
          // A backslash-newline is a JS line continuation: it denotes nothing.
          if (sequence === "\n" || sequence === "\r") return "";
          return SCRIPT_STRING_ESCAPES[sequence] ?? sequence;
        }
        const hex = sequence.startsWith("u{") ? sequence.slice(2, -1) : sequence.slice(1);
        return codePointOrLiteral(hex, match);
      },
    );
}

/** Decode a hex code point, falling back to the escape's literal text when invalid. */
function codePointOrLiteral(hex: string, literal: string): string {
  const code = Number.parseInt(hex, 16);
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return literal;
  try {
    return String.fromCodePoint(code);
  } catch {
    return literal;
  }
}

/**
 * Build a turn's `[start, end]` wall-clock interval from its `task_complete`.
 * `end` is the completion record's own timestamp (ISO, ms precision); `start`
 * is the matching `task_started`'s timestamp, or — when that record is absent
 * (a session whose first turn was already in progress at import) —
 * reconstructed as `end - duration_ms`. Returns `undefined` when no start can
 * be resolved or the span is non-positive, so the caller falls back to the
 * gap-capped engagement series for that turn.
 */
function turnIntervalFromComplete(
  endTs: string,
  payload: Record<string, unknown>,
  startMsByTurnId: ReadonlyMap<string, number>,
): IntervalMs | undefined {
  const endMs = Date.parse(endTs);
  if (!Number.isFinite(endMs)) return undefined;
  const turnId = readString(payload.turn_id);
  const indexedStart = turnId !== undefined ? startMsByTurnId.get(turnId) : undefined;
  const durationMs = readNonNegInt(payload.duration_ms);
  const startMs =
    indexedStart !== undefined ? indexedStart : durationMs > 0 ? endMs - durationMs : undefined;
  if (startMs === undefined || !(startMs < endMs)) return undefined;
  return [startMs, endMs];
}

/**
 * Index each turn's start time (epoch ms) by its `turn_id` from the
 * `task_started` records. First occurrence wins. Lets a `task_complete` recover
 * the real turn start regardless of record order.
 */
function indexTaskStarts(records: ReadonlyArray<CodexRolloutRecord>): Map<string, number> {
  const byTurnId = new Map<string, number>();
  for (const record of records) {
    if (readString(record.type) !== "event_msg") continue;
    const payload = isObject(record.payload) ? record.payload : undefined;
    if (payload === undefined || readString(payload.type) !== "task_started") continue;
    const turnId = readString(payload.turn_id);
    const startMs = Date.parse(readString(record.timestamp) ?? "");
    if (turnId !== undefined && Number.isFinite(startMs) && !byTurnId.has(turnId)) {
      byTurnId.set(turnId, startMs);
    }
  }
  return byTurnId;
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
 * Codex's output text reports wall-clock duration as `Wall time: X seconds` for
 * a per-command `exec_command` call and `Wall time X seconds` (no colon) for a
 * whole script, so the colon is optional here. Returns `0` (the schema floor)
 * when absent or non-finite, matching the Claude importer's missing-duration
 * default.
 */
function parseWallTimeMs(output: string | undefined): number {
  if (output === undefined) return 0;
  const match = output.match(/Wall time:?\s*([\d.]+)\s*seconds/);
  if (match?.[1] === undefined) return 0;
  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * Index every tool output's text by its `call_id`, so a command's exit code and
 * duration can be looked up at the originating call.
 *
 * A `function_call_output` carries its text as a plain string; only strings are
 * kept there because an array output is an image / structured tool result that
 * carries no command outcome. A scripted `custom_tool_call_output` instead
 * carries an ARRAY of content parts (`{ type: "input_text", text }`) whose FIRST
 * part is the outcome banner (`Script completed` / `Wall time X seconds`), so
 * those parts are joined back into one text.
 */
function indexOutputs(records: ReadonlyArray<CodexRolloutRecord>): Map<string, string> {
  const byId = new Map<string, string>();
  for (const record of records) {
    if (readString(record.type) !== "response_item") continue;
    const payload = isObject(record.payload) ? record.payload : undefined;
    if (payload === undefined) continue;
    const payloadType = readString(payload.type);
    const output =
      payloadType === "function_call_output"
        ? readString(payload.output)
        : payloadType === "custom_tool_call_output"
          ? readOutputParts(payload.output)
          : undefined;
    const callId = readString(payload.call_id);
    if (callId !== undefined && output !== undefined) byId.set(callId, output);
  }
  return byId;
}

/** Join a scripted tool output's content parts (or read it as a plain string). */
function readOutputParts(value: unknown): string | undefined {
  const asString = readString(value);
  if (asString !== undefined) return asString;
  if (!Array.isArray(value)) return undefined;
  const texts = value
    .map((part) => (isObject(part) ? readString(part.text) : undefined))
    .filter((text): text is string => text !== undefined);
  return texts.length > 0 ? texts.join("\n") : undefined;
}
