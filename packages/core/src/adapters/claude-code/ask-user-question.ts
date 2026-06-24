/**
 * Shared parsing for Claude Code `AskUserQuestion` tool uses, used by two
 * consumers that must agree on what counts as a confirmed selection:
 *
 *  - the transcript importer, which derives a `decision_recorded` event from
 *    each answer that EXACTLY matches an offered option label (a confirmed
 *    selection), and
 *  - the Stop-hook trigger, which treats the inverse — a free-text / "Other"
 *    reply matching no offered label — as an uncaptured conversational decision
 *    point worth nudging the agent to capture.
 *
 * Keeping the option-matching rule in one place is what guarantees the two stay
 * consistent: the set the importer derives and the set the hook counts as
 * uncaptured are exact complements of one another.
 *
 * The transcript shape is the vendor's undocumented internal message log, so
 * every field is read defensively (mirrors the importer's reader style).
 */

type Record_ = Record<string, unknown>;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the `tool_use` items from an assistant record's `message.content[]`. */
function toolUsesOf(record: Record_): Array<Record_> {
  const message = isObject(record.message) ? record.message : undefined;
  const content = message !== undefined && Array.isArray(message.content) ? message.content : [];
  const result: Array<Record_> = [];
  for (const item of content) {
    if (isObject(item) && readString(item.type) === "tool_use") result.push(item);
  }
  return result;
}

/**
 * Index the structured answers of every `AskUserQuestion` tool use by its
 * tool_use id. The chosen answers live on the *result* record's
 * `toolUseResult.answers` — a `{ "<question>": "<chosen answer>" }` map — which
 * is only present on AskUserQuestion results, so its presence is the
 * discriminator. The result record carries the originating tool_use id inside
 * its `message.content[].tool_use_id`.
 */
export function indexAskAnswers(records: ReadonlyArray<Record_>): Map<string, Record_> {
  const byId = new Map<string, Record_>();
  for (const record of records) {
    const result = record.toolUseResult;
    if (!isObject(result)) continue;
    const answers = result.answers;
    if (!isObject(answers)) continue;
    const message = isObject(record.message) ? record.message : undefined;
    const content = message !== undefined && Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (isObject(item) && readString(item.type) === "tool_result") {
        const id = readString(item.tool_use_id);
        if (id !== undefined) byId.set(id, answers);
      }
    }
  }
  return byId;
}

/**
 * Map each AskUserQuestion question to the set of option labels it OFFERED. The
 * labels live on the tool_use input (`input.questions[].options[].label`); the
 * recorded answer is matched against them to tell a real selection from a
 * free-text "Other" reply. Returns an empty map for any unexpected shape.
 */
export function readOfferedOptions(input: Record_): Map<string, Set<string>> {
  const byQuestion = new Map<string, Set<string>>();
  const questions = Array.isArray(input.questions) ? input.questions : [];
  for (const q of questions) {
    if (!isObject(q)) continue;
    const text = readString(q.question);
    if (text === undefined) continue;
    const labels = new Set<string>();
    const options = Array.isArray(q.options) ? q.options : [];
    for (const o of options) {
      if (!isObject(o)) continue;
      const label = readString(o.label);
      if (label !== undefined) labels.add(label.trim());
    }
    byQuestion.set(text, labels);
  }
  return byQuestion;
}

/**
 * Count the AskUserQuestion answers across a transcript that are NOT confirmed
 * selections — a non-empty answer matching no option the question offered (a
 * free-text "Other" reply: a counter-question, guidance, or other meta/free-form
 * choice). This is the exact complement of the importer's confirmed-selection
 * rule: such answers are deliberately NOT auto-derived as decisions, so they are
 * precisely the uncaptured conversational decisions the Stop-hook exists to
 * catch. One count per qualifying answer; multi-select serialization is
 * undocumented so each entry is treated as a single answer string.
 */
export function countUncapturedDecisionPoints(records: ReadonlyArray<Record_>): number {
  const answersById = indexAskAnswers(records);
  if (answersById.size === 0) return 0;
  let count = 0;
  for (const record of records) {
    if (readString(record.type) !== "assistant") continue;
    for (const tool of toolUsesOf(record)) {
      if (readString(tool.name) !== "AskUserQuestion") continue;
      const useId = readString(tool.id);
      const answers = useId !== undefined ? answersById.get(useId) : undefined;
      if (answers === undefined) continue;
      const input = isObject(tool.input) ? tool.input : undefined;
      if (input === undefined) continue;
      const offeredByQuestion = readOfferedOptions(input);
      for (const [question, answer] of Object.entries(answers)) {
        if (question.length === 0) continue;
        // Trim before testing (as the importer does) and skip empty /
        // whitespace-only answers: those are neither a confirmed selection nor a
        // meaningful free-form reply, so they belong in NEITHER set.
        const trimmed = typeof answer === "string" ? answer.trim() : "";
        if (trimmed.length === 0) continue;
        const offered = offeredByQuestion.get(question);
        // Free-form: the inverse of the importer's confirmed-selection test (a
        // non-empty answer matching no offered option label).
        if (offered === undefined || !offered.has(trimmed)) count += 1;
      }
    }
  }
  return count;
}
