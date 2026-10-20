import { BOARD_HTTP_MAX_REDIRECTS, type BoardObserve } from "./declaration.js";
import { HIDDEN_CHAR, shownText } from "./shown-text.js";

/** The lowest status an `http` observation's value may hold: a response's, never curl's `000`. */
export const BOARD_HTTP_STATUS_MIN = 100;

/** The highest status an `http` observation's value may hold. */
export const BOARD_HTTP_STATUS_MAX = 599;

// How many characters of a value's JSON a problem shows of what it received,
// an escape counted as one.
const RECEIVED_MAX = 60;

/** A problem of an observation's value: where in the value, and what is wrong. */
export type ObservedValueProblem = { path: (string | number)[]; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// What was received, as JSON on one line, cut short where an escape of it
// ends, with nothing in it that a terminal acts on or hides. The value is a
// JSON value that nests no deeper than a record takes: record checks that
// before it holds one against its kind. The check of the input for other
// workspaces' names runs before this one, so what is shown names none.
function received(value: unknown): string {
  let text: string;
  try {
    text = value === undefined ? "nothing" : (JSON.stringify(value) ?? String(value));
  } catch {
    return "received a value too deep to show";
  }
  const parts = text.match(/\\u[0-9a-fA-F]{4}|\\.|[\s\S]/gu) ?? [];
  const shown = parts.slice(0, RECEIVED_MAX).map((part) => (part.length === 1 ? shownText(part) : part));
  return `received ${shown.join("")}${parts.length > RECEIVED_MAX ? "..." : ""}`;
}

function isWholeNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

// Characters a value copied from a command's output may carry by mistake:
// a control character (a line break, a tab, an escape), one a terminal hides
// (a zero-width or direction mark, a line separator, a byte order mark), and
// white space at either end. Each would read as a change from the previous
// record's value, and none is in what the guide's commands print.
function hasControl(text: string): boolean {
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const SPACE_AT_AN_END = /^\s|\s$/u;

function isPlainText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !hasControl(value) &&
    !HIDDEN_CHAR.test(value) &&
    !SPACE_AT_AN_END.test(value)
  );
}

function isAbsoluteHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || hasControl(value) || /\s/u.test(value)) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    return new URL(value).hostname !== "";
  } catch {
    return false;
  }
}

/**
 * What is wrong with the value of an observation, held against the shape its
 * kind gives it: every problem, for an `http` value its keys it does not take
 * first, then those left out, then status, redirects, final_url, words, count
 * and capture. A null value (the observation was not made) is never held
 * here, nor is a `manual` one, which is what the operator answers. The value
 * is a JSON value no deeper than a record takes.
 */
export function observedValueProblems(o: BoardObserve, value: unknown): ObservedValueProblem[] {
  const kind = `(kind '${o.kind}')`;
  switch (o.kind) {
    case "manual":
      return [];
    case "npm_version":
    case "github_release":
    case "github_ci":
    case "github_check":
    case "page_version":
      return isPlainText(value)
        ? []
        : [
            {
              path: [],
              message: `must be a non-empty string with no space or line break at either end and no control or hidden character ${kind}, ${received(value)}`,
            },
          ];
    case "github_open_issues":
    case "github_open_prs":
      return isWholeNumber(value, 0, Number.MAX_SAFE_INTEGER)
        ? []
        : [
            {
              path: [],
              message: `must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER} ${kind}, ${received(value)}`,
            },
          ];
    case "http":
      return httpValueProblems(o, value);
  }
}

// The keys of an http value, in the order the guide's command prints them:
// the three of every response, then those the observation declares a read of.
function httpKeys(o: Extract<BoardObserve, { kind: "http" }>): string[] {
  return [
    "status",
    "redirects",
    "final_url",
    ...(o.words === undefined ? [] : ["words"]),
    ...(o.count_pattern === undefined ? [] : ["count"]),
    ...(o.capture_pattern === undefined ? [] : ["capture"]),
  ];
}

function httpValueProblems(
  o: Extract<BoardObserve, { kind: "http" }>,
  value: unknown,
): ObservedValueProblem[] {
  const keys = httpKeys(o);
  if (!isRecord(value)) {
    return [
      {
        path: [],
        message: `must be an object of ${keys.join(", ")} (kind 'http'), ${received(value)}`,
      },
    ];
  }
  const problems: ObservedValueProblem[] = [];
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      problems.push({
        path: [key],
        message: `is not a key of this observation's value (it takes ${keys.join(", ")})`,
      });
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      problems.push({
        path: [key],
        message:
          key === "words" || key === "count" || key === "capture"
            ? `must be given: the observation declares ${key === "words" ? "words" : `a ${key}_pattern`} (null when the status is not 2xx)`
            : "must be given",
      });
    }
  }
  const { status, redirects, final_url: finalUrl } = value;
  const statusKnown = isWholeNumber(status, BOARD_HTTP_STATUS_MIN, BOARD_HTTP_STATUS_MAX);
  if (Object.hasOwn(value, "status") && !statusKnown) {
    problems.push({
      path: ["status"],
      message: `must be a whole number from ${BOARD_HTTP_STATUS_MIN} to ${BOARD_HTTP_STATUS_MAX}, the status of a response, ${received(status)}`,
    });
  }
  if (Object.hasOwn(value, "redirects") && !isWholeNumber(redirects, 0, BOARD_HTTP_MAX_REDIRECTS)) {
    problems.push({
      path: ["redirects"],
      message: `must be a whole number from 0 to ${BOARD_HTTP_MAX_REDIRECTS}, ${received(redirects)}`,
    });
  }
  if (Object.hasOwn(value, "final_url") && !isAbsoluteHttpUrl(finalUrl)) {
    problems.push({
      path: ["final_url"],
      message: `must be an absolute http or https URL, ${received(finalUrl)}`,
    });
  }
  // The body is read only when the status is 2xx. With a status that is not
  // a status, either shape is let through: the status is what is wrong.
  const read = statusKnown ? status >= 200 && status <= 299 : undefined;
  const notRead = (key: string) => ({
    path: [key],
    message: `must be null: the status ${String(status)} is not 2xx, so the body is not read, ${received(value[key])}`,
  });
  if (o.words !== undefined && Object.hasOwn(value, "words")) {
    const words = value.words;
    const asRead =
      Array.isArray(words) &&
      words.length === o.words.length &&
      words.every((w) => typeof w === "boolean");
    if (read === false && words !== null) problems.push(notRead("words"));
    else if (read === true && !asRead) {
      problems.push({
        path: ["words"],
        message: `must be a list of ${o.words.length} true or false, one for each word declared, in its order, ${received(words)}`,
      });
    } else if (read === undefined && words !== null && !asRead) {
      problems.push({
        path: ["words"],
        message: `must be a list of ${o.words.length} true or false, or null when the status is not 2xx, ${received(words)}`,
      });
    }
  }
  if (o.count_pattern !== undefined && Object.hasOwn(value, "count")) {
    const count = value.count;
    const asRead = isWholeNumber(count, 0, Number.MAX_SAFE_INTEGER);
    if (read === false) {
      if (count !== null) problems.push(notRead("count"));
    } else if (!asRead && (read === true || count !== null)) {
      const orNull = read === true ? "" : ", or null when the status is not 2xx";
      problems.push({
        path: ["count"],
        message: `must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER} (0 when nothing matches)${orNull}, ${received(count)}`,
      });
    }
  }
  if (o.capture_pattern !== undefined && Object.hasOwn(value, "capture")) {
    const capture = value.capture;
    // What the group holds is kept as it is, spaces and all.
    if (read === false && capture !== null) problems.push(notRead("capture"));
    else if (capture !== null && typeof capture !== "string") {
      problems.push({
        path: ["capture"],
        message: `must be a string, or null when nothing matches, ${received(capture)}`,
      });
    }
  }
  return problems;
}
