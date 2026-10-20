import { displayPath } from "../lib/display-path.js";

// What a terminal would act on, or hides: the C1 controls, the Arabic letter
// mark, the zero-width and direction marks, the line and paragraph
// separators, the bidirectional controls, the word joiner and the invisible
// operators, and the byte order mark.
const HIDDEN_CLASS = "[\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]";

/** One character a terminal would act on, or hides (see {@link escapeHidden}). */
export const HIDDEN_CHAR = new RegExp(HIDDEN_CLASS, "u");

/** Every character a terminal would act on, or hides. */
export const HIDDEN = new RegExp(HIDDEN_CLASS, "gu");

/** A character as a `\uXXXX` escape. */
export const escapeHidden = (c: string) =>
  `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;

// A surrogate not in a pair, which JSON.stringify writes as an escape.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A text as basou shows a value a board holds: as displayPath shows it, with
 * what a terminal hides escaped too, and a surrogate not in a pair, so that
 * the guide's prose, a source, the template and a refusal show a value alike.
 */
export function shownText(text: string): string {
  return displayPath(text).replace(HIDDEN, escapeHidden).replace(LONE_SURROGATE, escapeHidden);
}
