import { boardInitStrings, type ViewLanguage } from "../lib/view-strings.js";
import { BOARD_STAGE_IDS, BOARD_VERSION } from "./declaration.js";

/** The id of the lane a printed board starts with, to be cut again. */
export const BOARD_INIT_LANE_ID = "replace-me";

/** How many days an axis is reviewed after, in a printed board. */
export const BOARD_INIT_REVIEW_DUE_DAYS = 60;

export type BoardInitInput = {
  /** The workspace's name, which the title starts with. */
  name: string;
  /** The language of the words the board starts with: the anchor's. */
  language: ViewLanguage;
  /** The day the effort starts, `YYYY-MM-DD`. */
  start: string;
  /** This host's time zone, or undefined when it has no name. */
  timeZone: string | undefined;
};

// A YAML 1.2 scalar that reads back as the string given: JSON's quoting is
// YAML's double-quoted style, with what a terminal would act on escaped.
function quoted(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

// A comment of one line, whatever its text.
function comment(text: string): string {
  return `# ${text.replace(/\s+/g, " ")}`;
}

/**
 * The text of a board.yaml to start from, of the newest board_version: the
 * title from the workspace's name, the six stages with a meaning each, one
 * sample lane (a board needs one), nothing to observe, no component
 * registered (the first measurement names every one it finds, which fires
 * the axis review that registers them), an axis of version 1 with no review
 * on record (the first record is its first review), and the effort from the
 * day given, in this host's time zone when it has a name. It reads as a
 * declaration as it is.
 */
export function boardInitText(input: BoardInitInput): string {
  const t = boardInitStrings(input.language);
  const lines = [
    comment(t.comments.head),
    `board_version: ${BOARD_VERSION}`,
    `title: ${quoted(t.title.replace("{name}", () => input.name))}`,
    "",
    comment(t.comments.stages),
    "stages:",
    ...BOARD_STAGE_IDS.map((id) => `  "${id}": { meaning: ${quoted(t.stages[id])} }`),
    "",
    comment(t.comments.lanes),
    "lanes:",
    `  - id: ${BOARD_INIT_LANE_ID}`,
    `    name: ${quoted(t.lane.name)}`,
    `    about: ${quoted(t.lane.about)}`,
    "    notes:",
    `      - ${quoted(t.lane.note)}`,
    "",
    comment(t.comments.observe),
    "observe: []",
    "",
    comment(t.comments.components),
    "components: {}",
    "",
    comment(t.comments.axis),
    "axis:",
    "  version: 1",
    `  review_due_days: ${BOARD_INIT_REVIEW_DUE_DAYS}`,
    "",
    comment(t.comments.effort),
    "effort:",
    `  start: ${quoted(input.start)}`,
    input.timeZone === undefined
      ? `  ${comment(t.comments.timeZone)}`
      : `  time_zone: ${quoted(input.timeZone)}`,
  ];
  return `${lines.join("\n")}\n`;
}
