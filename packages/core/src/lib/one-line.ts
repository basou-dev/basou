/**
 * Collapse every run of whitespace in a recorded string to a single space.
 *
 * Text that came from outside the renderer carries whatever the recorder put
 * in it: a session label is the command line, so `basou run codex exec
 * <prompt>` records a whole prompt there. A generated Markdown document has no
 * way to hold a newline inside a table cell or a bullet -- the newline ends the
 * row, and whatever followed begins a new line of the document. A line the
 * recorded text began with `#` then becomes a heading of the document itself,
 * mixing into its section structure.
 *
 * `\s` covers every line terminator CommonMark recognises (LF, CR, CRLF) along
 * with the separators U+2028 / U+2029, so collapsing it is enough to keep the
 * text on the line it was rendered into.
 *
 * Renderers that write into a table cell must escape the column delimiter as
 * well; see the handoff renderer's `tableCell`.
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
