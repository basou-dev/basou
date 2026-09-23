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

  it("does not turn an escaped name into an unescaped one", () => {
    // `a\nb` (a real newline) and `a b` must not render the same.
    expect(displayPath("a\nb")).not.toBe(displayPath("a b"));
  });
});
