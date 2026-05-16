import { readFile } from "node:fs/promises";
import { atomicReplace } from "./atomic.js";

/** Marker line that begins the auto-generated region. */
export const GENERATED_START = "<!-- BASOU:GENERATED:START -->";
/** Marker line that ends the auto-generated region. */
export const GENERATED_END = "<!-- BASOU:GENERATED:END -->";

/**
 * Result of parsing a markdown body for the BASOU:GENERATED marker region.
 *
 * Y-2 §10.2 mandates strict line-level matching: a marker is only recognized
 * when an entire line is exactly the marker string. Leading/trailing
 * whitespace, comment compression, and BOM are treated as legacy formats
 * (`no_markers`) so that re-generation refuses to silently overwrite a
 * mismatched manual edit.
 */
export type MarkerSection =
  | { kind: "ok"; before: string; generated: string; after: string }
  | { kind: "no_markers" }
  | { kind: "missing_start" }
  | { kind: "missing_end" }
  | { kind: "multiple_pairs" }
  | { kind: "wrong_order" };

/**
 * Read a markdown file as UTF-8 text. Returns `null` when the file does not
 * exist; throws `Error("Failed to read markdown file", { cause })` for other
 * I/O failures (pathless contract — never embed the absolute path in the
 * thrown `message`).
 */
export async function readMarkdownFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") return null;
    throw new Error("Failed to read markdown file", { cause: error });
  }
}

/**
 * Atomically write a markdown body via {@link atomicReplace}. The shared
 * helper handles the tmp-file + rename sequence, `wx` collision guard, and
 * best-effort tmp cleanup on failure.
 *
 * On any failure the original error is re-thrown as
 * `Error("Failed to write markdown file", { cause })` (pathless contract).
 */
export async function writeMarkdownFile(filePath: string, body: string): Promise<void> {
  try {
    await atomicReplace(filePath, body);
  } catch (error: unknown) {
    throw new Error("Failed to write markdown file", { cause: error });
  }
}

/**
 * Parse a markdown body and identify the BASOU:GENERATED marker region.
 *
 * Returns one of six `kind` discriminants:
 * - `ok`: exactly one START line followed by exactly one END line in the
 *   correct order. `before` / `generated` / `after` slice the original
 *   text by character offsets so CRLF / LF are preserved verbatim outside
 *   the marker region.
 * - `no_markers`: both START and END absent (legacy file / fresh write).
 * - `missing_start` / `missing_end`: exactly one of the pair is present.
 * - `multiple_pairs`: more than one START or END line.
 * - `wrong_order`: END appears before START.
 *
 * Matching is strict: leading/trailing whitespace, BOM, and comment
 * compression (`<!--BASOU:...-->`) all bypass the marker and are treated
 * as legacy content.
 */
export function parseMarkers(content: string): MarkerSection {
  // Split on either CRLF or LF so the line count is consistent regardless of
  // the file's line ending. The reconstruction step below slices the original
  // string by character offsets to preserve the actual line endings outside
  // the generated region.
  const lines = content.split(/\r?\n/);
  const startLines: number[] = [];
  const endLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === GENERATED_START) startLines.push(i);
    else if (lines[i] === GENERATED_END) endLines.push(i);
  }
  if (startLines.length === 0 && endLines.length === 0) return { kind: "no_markers" };
  if (startLines.length === 0) return { kind: "missing_start" };
  if (endLines.length === 0) return { kind: "missing_end" };
  if (startLines.length >= 2 || endLines.length >= 2) return { kind: "multiple_pairs" };
  const startLineIdx = startLines[0] as number;
  const endLineIdx = endLines[0] as number;
  if (endLineIdx < startLineIdx) return { kind: "wrong_order" };

  // Walk the original string to find byte offsets of the marker lines. This
  // preserves CRLF vs LF in the surrounding text — splitting and re-joining
  // would normalize the line endings.
  const startOffset = lineStartOffset(content, startLineIdx);
  const endLineStart = lineStartOffset(content, endLineIdx);
  const startLineEnd = startOffset + GENERATED_START.length;
  const endLineEnd = endLineStart + GENERATED_END.length;

  const before = content.slice(0, startOffset);
  // The generated region is everything between the two marker lines,
  // exclusive of the marker line themselves but including the newline after
  // START and excluding the newline before END (so re-render can plug in
  // its own body without doubling separators).
  const afterStartNewline = skipOneNewline(content, startLineEnd);
  const beforeEndNewline = trimOneNewline(content, endLineStart);
  const generated = content.slice(afterStartNewline, beforeEndNewline);
  const after = content.slice(endLineEnd);
  return { kind: "ok", before, generated, after };
}

/**
 * Build the final markdown body by replacing the BASOU:GENERATED region.
 *
 * - `existing === null` (no file yet): return `<START>\n<generated>\n<END>\n`.
 * - existing parses to `ok`: replace the marked region and keep everything
 *   before START and after END untouched (preserving manual additions).
 * - any other parse result: throw a pathless error referencing `fileLabel`.
 *
 * The caller passes `fileLabel` (e.g. `"handoff.md"` or `"decisions.md"`)
 * so the error message is informative without leaking an absolute path.
 */
export function renderWithMarkers(
  existing: string | null,
  generated: string,
  fileLabel: string,
): string {
  const normalized = generated.endsWith("\n") ? generated : `${generated}\n`;
  if (existing === null) {
    return `${GENERATED_START}\n${normalized}${GENERATED_END}\n`;
  }
  const section = parseMarkers(existing);
  switch (section.kind) {
    case "ok":
      return `${section.before}${GENERATED_START}\n${normalized}${GENERATED_END}${section.after}`;
    case "no_markers":
      throw new Error(`Markers missing in ${fileLabel}`);
    case "missing_start":
    case "missing_end":
    case "multiple_pairs":
    case "wrong_order":
      throw new Error(`Markers mismatched in ${fileLabel}`);
  }
}

/** Character offset of the first character of `lineIdx` (0-based). */
function lineStartOffset(content: string, lineIdx: number): number {
  if (lineIdx === 0) return 0;
  let offset = 0;
  let line = 0;
  while (offset < content.length && line < lineIdx) {
    const ch = content[offset];
    if (ch === "\n") {
      line += 1;
      offset += 1;
    } else if (ch === "\r") {
      // CR or CRLF both count as a line terminator.
      offset += 1;
      if (content[offset] === "\n") offset += 1;
      line += 1;
    } else {
      offset += 1;
    }
  }
  return offset;
}

/** Advance past one trailing `\n` or `\r\n` if present. */
function skipOneNewline(content: string, offset: number): number {
  if (content[offset] === "\r" && content[offset + 1] === "\n") return offset + 2;
  if (content[offset] === "\n") return offset + 1;
  return offset;
}

/** Walk back past one leading `\n` or `\r\n` if present. */
function trimOneNewline(content: string, offset: number): number {
  if (offset >= 2 && content[offset - 2] === "\r" && content[offset - 1] === "\n")
    return offset - 2;
  if (offset >= 1 && content[offset - 1] === "\n") return offset - 1;
  return offset;
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  const codeProp = (error as unknown as Record<string, unknown>).code;
  return typeof codeProp === "string";
}
