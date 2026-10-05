import { describe, expect, it } from "vitest";
import {
  compileGlob,
  compileGlobs,
  fromBytes,
  mayMatchUnder,
  normalizePathspec,
  toBytes,
} from "./glob.js";

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
    expect(compileGlob("caf\u00e9/*.md")(toBytes("caf\u00e9/a.md"))).toBe(true);
  });

  it("matches a '[' with no closing ']' literally, as a path and never as a class", () => {
    expect(compileGlob("a[b")("a[b")).toBe(true);
    expect(compileGlob("a[b*")("a[bc")).toBe(false);
  });

  it("matches a pattern literally before matching it as a glob", () => {
    const m = compileGlob("app/[slug]/page.tsx");
    expect(m("app/[slug]/page.tsx")).toBe(true);
    expect(m("app/s/page.tsx")).toBe(true);
    expect(compileGlob("app/[slug]")("app/[slug]/page.tsx")).toBe(true);
    // An escape makes it a glob, which must match the whole path.
    expect(compileGlob("app/\\[slug\\]")("app/[slug]/page.tsx")).toBe(false);
    expect(compileGlob("app/\\[slug\\]/*.tsx")("app/[slug]/page.tsx")).toBe(true);
  });

  it("keeps a trailing slash: a directory only, and never a file", () => {
    expect(compileGlob("docs/")("docs/a.md")).toBe(true);
    expect(compileGlob("docs/")("docs")).toBe(false);
    expect(compileGlob("*/")("docs/a.md")).toBe(false);
    expect(compileGlob("**/")("docs/a.md")).toBe(false);
  });

  it("lets '**' right after a literal prefix match across directories, as git does", () => {
    expect(compileGlob("docs**")("docs/spec/b.md")).toBe(true);
    expect(compileGlob("docs**")("docsx")).toBe(true);
    expect(compileGlob("a/**b")("a/x/b")).toBe(false);
  });

  it("supports the POSIX classes and a ']' first in a class", () => {
    expect(compileGlob("[[:upper:]]*")("README.md")).toBe(true);
    expect(compileGlob("[[:upper:]]*")("package.json")).toBe(false);
    expect(compileGlob("x[[:digit:]]")("x7")).toBe(true);
    expect(compileGlob("[]]x")("]x")).toBe(true);
    expect(compileGlob("[[:bogus:]]")("b")).toBe(false);
  });

  it("matches bytes, so '?' is one byte of a multibyte character", () => {
    expect(compileGlob("caf?/a.md")(toBytes("caf\u00e9/a.md"))).toBe(false);
    expect(compileGlob("caf??/a.md")(toBytes("caf\u00e9/a.md"))).toBe(true);
  });

  it("matches a path that is not valid UTF-8 as its bytes", () => {
    const bad = Buffer.from([0x6e, 0x2f, 0x62, 0xff]).toString("latin1");
    expect(compileGlob("n/*")(bad)).toBe(true);
    expect(compileGlob("n/b?")(bad)).toBe(true);
    expect(fromBytes(bad)).toBe("n/b\ufffd");
  });

  it("normalizes '.' segments and repeated slashes, and keeps a trailing slash", () => {
    expect(normalizePathspec("./docs//a.md")).toBe("docs/a.md");
    expect(normalizePathspec("docs/./spec/")).toBe("docs/spec/");
    expect(normalizePathspec(".")).toBe("");
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

describe("mayMatchUnder", () => {
  it.each<[string, string, boolean]>([
    ["**", "secret", true],
    ["*.txt", "logs", false],
    ["*/x.ts", "secret", true],
    ["src/*.ts", "src/hidden", false],
    ["src/**/*.ts", "src/hidden", true],
    ["src/*", "src/hidden", false],
    ["src/*", "src", true],
    ["src", "src/hidden", true],
    ["src/a.ts", "src", true],
    ["docs/a.md", "src", false],
    ["s*/x", "src/hidden", false],
    ["s*/*/x", "src/hidden", true],
    ["s?c/**", "src", true],
    ["[a-c]*/x", "src", false],
    ["a\\*b/x", "src", true],
    ["anything", "", true],
  ])("'%s' under '%s' is %s", (pattern, dir, expected) => {
    expect(mayMatchUnder(pattern, dir)).toBe(expected);
  });

  it("never says no when a path under the directory matches", () => {
    const dirs = ["docs", "docs/spec", "packages", "packages/cli", "packages/cli/src", "x"];
    const names = ["a.md", "b.ts", "package.json", "deep/c.ts", "deep/er/d.md", "x"];
    const patterns = [
      "*",
      "*.md",
      "**",
      "**/*.ts",
      "docs/*",
      "docs/**",
      "*/spec/*",
      "packages/*/src/*",
      "packages/*/src/**/*.ts",
      "p*/c?i/**",
      "x",
      "x/*",
      "*/*/*",
      "[dp]*/**/d.md",
    ];
    for (const dir of dirs) {
      const under = names.map((name) => `${dir}/${name}`);
      for (const pattern of patterns) {
        if (under.some(compileGlob(pattern)))
          expect([pattern, dir, mayMatchUnder(pattern, dir)]).toEqual([pattern, dir, true]);
      }
    }
  });
});
