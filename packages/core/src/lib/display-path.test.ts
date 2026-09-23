import { describe, expect, it } from "vitest";
import { displayPath } from "./display-path.js";

describe("displayPath", () => {
  it("leaves an ordinary path exactly as it is", () => {
    expect(displayPath("packages/core/src/index.ts")).toBe("packages/core/src/index.ts");
  });

  it("leaves non-ASCII, quotes, backslashes and spaces alone", () => {
    const name = ` 日本語 "q" back\\slash .md `;
    expect(displayPath(name)).toBe(name);
  });

  it.each([
    ["a newline", "a\nb.txt", "a\\nb.txt"],
    ["a carriage return", "a\rb.txt", "a\\rb.txt"],
    ["a tab", "a\tb.txt", "a\\tb.txt"],
    ["an ESC byte", "a\u001b[2Jb.txt", "a\\x1b[2Jb.txt"],
    ["a NUL", "a\u0000b", "a\\x00b"],
    ["DEL", "a\u007fb", "a\\x7fb"],
    ["a C1 control (NEL)", "a\u0085b", "a\\x85b"],
    ["the line separator", `a${String.fromCharCode(0x2028)}b`, "a\\u2028b"],
    ["the paragraph separator", `a${String.fromCharCode(0x2029)}b`, "a\\u2029b"],
  ])("makes %s visible", (_label, raw, shown) => {
    expect(displayPath(raw)).toBe(shown);
  });

  it("keeps a name that would forge a Markdown heading on one line", () => {
    const forged = "new\n\n## Forged section\ntext.txt";
    const shown = displayPath(forged);
    expect(shown).not.toMatch(/[\n\r]/);
    expect(`- ${shown}`.split("\n")).toHaveLength(1);
  });

  it("does not show a name with a line break as a name with a space", () => {
    expect(displayPath("a\nb")).not.toBe(displayPath("a b"));
  });

  it("is not reversible: a real newline and a literal backslash-n display alike", () => {
    // Documented, not a defect: the display keeps a name from acting; the
    // stored value is what identifies the file.
    expect(displayPath("a\nb")).toBe(displayPath("a\\nb"));
  });

  const ch = (code: number) => String.fromCharCode(code);

  it.each([
    [0x1f, "\\x1f"],
    [0x0b, "\\x0b"],
    [0x0c, "\\x0c"],
    [0x7f, "\\x7f"],
    [0x80, "\\x80"],
    [0x9b, "\\x9b"],
    [0x9d, "\\x9d"],
    [0x9f, "\\x9f"],
  ])("escapes U+%s at the edges of the control ranges", (code, shown) => {
    expect(displayPath(`a${ch(code)}b`)).toBe(`a${shown}b`);
  });

  it.each([0x20, 0x7e, 0xa0, 0x202f, 0x2065, 0x206a])(
    "leaves U+%s, just outside a range, alone",
    (code) => {
      expect(displayPath(`a${ch(code)}b`)).toBe(`a${ch(code)}b`);
    },
  );

  it.each([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])(
    "escapes the bidirectional control U+%s",
    (code) => {
      expect(displayPath(`a${ch(code)}b`)).toBe(`a\\u${code.toString(16)}b`);
    },
  );
});
