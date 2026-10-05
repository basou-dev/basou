import { describe, expect, it } from "vitest";
import { compileGlob, compileGlobs } from "./glob.js";

const FILES = [
  "CHANGELOG.md",
  "README.md",
  "package.json",
  "docs/a.md",
  "docs/spec/b.md",
  "packages/cli/package.json",
  "packages/cli/src/index.ts",
  "packages/cli/src/commands/board.ts",
  "packages/cli/src/commands/board.test.ts",
  "packages/core/package.json",
  "packages/core/src/index.ts",
  "packages/core/src/board/glob.ts",
  "packages/core/src/board/glob.test.ts",
  "packages/sdk/package.json",
];

function matching(pattern: string): string[] {
  return FILES.filter(compileGlob(pattern));
}

describe("compileGlob", () => {
  it.each<[string, string[]]>([
    ["*", ["CHANGELOG.md", "README.md", "package.json"]],
    ["*.md", ["CHANGELOG.md", "README.md"]],
    ["docs/*", ["docs/a.md"]],
    ["docs/*.md", ["docs/a.md"]],
    ["./docs/*.md", ["docs/a.md"]],
    ["packages/*", []],
    ["packages/*/src", []],
    [
      "packages/*/package.json",
      ["packages/cli/package.json", "packages/core/package.json", "packages/sdk/package.json"],
    ],
    ["packages/?ore/src/*.ts", ["packages/core/src/index.ts"]],
    [
      "packages/[cs]*/package.json",
      ["packages/cli/package.json", "packages/core/package.json", "packages/sdk/package.json"],
    ],
    ["packages/[!c]*/package.json", ["packages/sdk/package.json"]],
    ["packages/[^c]*/package.json", ["packages/sdk/package.json"]],
    ["packages/c[a-n]*/package.json", ["packages/cli/package.json"]],
  ])("matches %j against single segments", (pattern, expected) => {
    expect(matching(pattern)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    [
      "**/*.test.ts",
      ["packages/cli/src/commands/board.test.ts", "packages/core/src/board/glob.test.ts"],
    ],
    [
      "**/package.json",
      [
        "package.json",
        "packages/cli/package.json",
        "packages/core/package.json",
        "packages/sdk/package.json",
      ],
    ],
    [
      "packages/**/board/*",
      ["packages/core/src/board/glob.ts", "packages/core/src/board/glob.test.ts"],
    ],
    ["packages/**/index.ts", ["packages/cli/src/index.ts", "packages/core/src/index.ts"]],
    ["docs/**", ["docs/a.md", "docs/spec/b.md"]],
    ["**", FILES],
    ["**/src", []],
  ])("matches %j across directories", (pattern, expected) => {
    expect(matching(pattern)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["docs", ["docs/a.md", "docs/spec/b.md"]],
    ["docs/", ["docs/a.md", "docs/spec/b.md"]],
    [
      "packages/core/src/board",
      ["packages/core/src/board/glob.ts", "packages/core/src/board/glob.test.ts"],
    ],
    ["README.md", ["README.md"]],
    ["doc", []],
  ])("matches %j, which has no wildcard, as a path or a directory", (pattern, expected) => {
    expect(matching(pattern)).toEqual(expected);
  });

  it("never lets '*', '?' or a class cross '/'", () => {
    expect(compileGlob("a*b")("a/b")).toBe(false);
    expect(compileGlob("a?b")("a/b")).toBe(false);
    expect(compileGlob("a[/]b")("a/b")).toBe(false);
    expect(compileGlob("a[!x]b")("a/b")).toBe(false);
  });

  it("treats a '**' that is not a whole segment as '*'", () => {
    expect(compileGlob("a**b")("axyb")).toBe(true);
    expect(compileGlob("a**b")("a/b")).toBe(false);
  });

  it("matches escaped and regex-special characters literally", () => {
    expect(compileGlob("a\\*b")("a*b")).toBe(true);
    expect(compileGlob("a\\*b")("axb")).toBe(false);
    expect(compileGlob("a.b")("a.b")).toBe(true);
    expect(compileGlob("a.b")("axb")).toBe(false);
    expect(compileGlob("(a)+{b}|-c$")("(a)+{b}|-c$")).toBe(true);
    expect(compileGlob("[a-]x")("-x")).toBe(true);
    expect(compileGlob("[\\]]x")("]x")).toBe(true);
    expect(compileGlob("caf\u00e9/*.md")("caf\u00e9/a.md")).toBe(true);
  });

  it("matches a '[' with no closing ']' literally", () => {
    expect(compileGlob("a[b")("a[b")).toBe(true);
  });
});

describe("compileGlobs", () => {
  it("takes the includes minus the excludes, wherever the exclude's '**' is", () => {
    const m = compileGlobs(["packages/core/src/board/*.ts"], ["**/*.test.ts"]);
    expect(FILES.filter(m)).toEqual(["packages/core/src/board/glob.ts"]);
  });

  it("takes every file when there is no include", () => {
    const m = compileGlobs(undefined, ["packages"]);
    expect(FILES.filter(m)).toEqual([
      "CHANGELOG.md",
      "README.md",
      "package.json",
      "docs/a.md",
      "docs/spec/b.md",
    ]);
  });
});
