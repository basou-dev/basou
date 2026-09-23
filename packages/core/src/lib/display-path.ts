/**
 * Render a recorded file path for a human reader or a model: every character
 * that would act rather than read — a line break, a tab, an escape sequence —
 * becomes a visible escape, and every other character is left as it is.
 *
 * Paths are stored RAW, exactly as the filesystem names the file, because that
 * is the only spelling that identifies it. But a raw name can carry a newline,
 * and every place basou prints paths is line-structured: a generated Markdown
 * document, where a newline followed by `## ` in a file name becomes a heading
 * of the document; the position handed to a session at start, where it becomes
 * text the model reads as basou's own; and a terminal, where an ESC byte in a
 * name is an instruction to the terminal, not a character. So the conversion
 * happens where a path is SHOWN, never where it is kept.
 *
 * Not {@link oneLine}: collapsing a newline into a space turns `a\nb.txt` into
 * `a b.txt`, which is another, possibly real, file.
 *
 * Escaped: C0 controls (U+0000–U+001F), DEL, C1 controls (U+0080–U+009F), the
 * Unicode line and paragraph separators U+2028 / U+2029, which Markdown and
 * JavaScript both treat as line breaks, and the bidirectional embedding,
 * override and isolate controls (U+202A–U+202E, U+2066–U+2069), one of which is
 * enough to make every name after it on the line display reversed. `\n`, `\r`
 * and `\t` keep their familiar spellings; the rest become `\xHH` or `\uHHHH`.
 *
 * NOT reversible, and not meant to be. A backslash is not escaped -- it is an
 * ordinary character in a POSIX name, and doubling every one would make the
 * common case harder to read -- so a name containing a real newline and a name
 * containing the two characters `\` and `n` display the same. The display
 * keeps a name from acting; it does not identify it. Anything that must name
 * the file uses the stored value, which is exact.
 *
 * Markdown syntax inside the one line (`# `, `[..](..)`, `*`) is not escaped
 * either: the name can no longer leave its line, but a renderer may still
 * format what is on it.
 */
export function displayPath(path: string): string {
  let shown = "";
  for (const c of path) {
    const code = c.codePointAt(0) ?? 0;
    if (!isActing(code)) {
      shown += c;
    } else if (c === "\n") {
      shown += "\\n";
    } else if (c === "\r") {
      shown += "\\r";
    } else if (c === "\t") {
      shown += "\\t";
    } else if (code <= 0xff) {
      shown += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      shown += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return shown;
}

/**
 * C0 controls, DEL, C1 controls, the Unicode line / paragraph separators, and
 * the bidirectional embedding / override / isolate controls.
 * Written as code points rather than a character class: the two separators are
 * themselves line terminators, and a source file that spells them literally is
 * one editor away from a broken line.
 */
function isActing(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}
