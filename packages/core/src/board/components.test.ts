import { describe, expect, it } from "vitest";
import { measureComponents, type PreviousComponents } from "./components.js";
import type { RepoScopeResult } from "./scope.js";

// A working tree holding `paths` (byte strings, as git lists them).
function tree(paths: string[]): () => Promise<RepoScopeResult> {
  const entries = new Map(paths.map((path) => [path, { kind: "file" }]));
  return async () =>
    ({
      ok: true,
      scope: { at: "worktree", entries, unread: new Map(), read: async () => ({}) },
    }) as unknown as RepoScopeResult;
}

const bytes = (text: string) => Buffer.from(text, "utf8").toString("latin1");

async function measured(name: string, paths: string[], registered: string[] = []) {
  return measureComponents({
    repos: ["."],
    names: new Map([[".", name]]),
    worktreeOf: tree(paths),
    registered: Object.fromEntries(registered.map((key) => [key, {}])),
  });
}

describe("measureComponents", () => {
  it("is not measured when a component's directory is not a valid UTF-8 name", async () => {
    // Two directories that would read the same once their bytes are replaced.
    const { components, notFound } = await measured("app", [
      "\xff/package.json",
      "\xfe/Dockerfile",
    ]);
    expect(components).toEqual({
      found: null,
      unacknowledged: null,
      gone: null,
      kind_changed: null,
    });
    expect(notFound).toEqual([
      {
        at: "components",
        reason:
          "in the repo '.', the directory '�' is not a valid UTF-8 name, so its component cannot be told apart from others",
      },
    ]);
  });

  it("reads a directory's name as UTF-8", async () => {
    const { components } = await measured("app", [bytes("データ/package.json")]);
    expect(Object.keys(components.found ?? {})).toEqual(["app/データ"]);
  });

  it("orders the lists by code point, whatever order an object gives its keys", async () => {
    const { components } = await measured("10", [
      "package.json",
      bytes("😀/package.json"),
      bytes("！/package.json"),
      "9/package.json",
    ]);
    // ！ (U+FF01) comes before 😀 (U+1F600) by code point, after it by UTF-16 unit.
    expect(components.unacknowledged).toEqual(["10", "10/9", "10/！", "10/😀"]);
    expect(Object.keys(components.found ?? {}).sort()).toEqual(
      [...(components.unacknowledged ?? [])].sort(),
    );
    const numbered = await measured("9", ["package.json"], ["10"]);
    expect(Object.keys(numbered.components.found ?? {})).toEqual(["9"]);
    expect(numbered.components.gone).toEqual(["10"]);
  });

  it("keeps a component named __proto__ as a key of its own", async () => {
    const { components } = await measured("__proto__", ["package.json", "svc/Dockerfile"]);
    expect(Object.keys(components.found ?? {})).toEqual(["__proto__", "__proto__/svc"]);
    // A literal { __proto__: ... } would set a prototype, so the text is compared.
    expect(JSON.stringify(components.found)).toBe(
      '{"__proto__":{"kinds":["manifest"],"status":"unacknowledged"},"__proto__/svc":{"kinds":["container"],"status":"unacknowledged"}}',
    );
    expect(Object.getPrototypeOf(components.found)).toBe(Object.prototype);
  });
});

describe("measureComponents against the previous record", () => {
  const against = (previous: PreviousComponents, paths: string[], registered: string[] = []) =>
    measureComponents({
      repos: ["."],
      names: new Map([[".", "app"]]),
      worktreeOf: tree(paths),
      registered: Object.fromEntries(registered.map((key) => [key, {}])),
      previous,
    });

  it("finds the kinds that changed, and counts gone what only the previous record found", async () => {
    const { components, notFound } = await against(
      {
        status: "found",
        found: {
          app: { kinds: ["manifest"] },
          "app/web": { kinds: ["manifest", "edge"] },
          "app/tmp": { kinds: ["container"] },
          "app/__proto__": { kinds: ["env"] },
        },
      },
      ["package.json", "Dockerfile", "web/package.json", "web/wrangler.toml", "svc/go.mod"],
      ["app/registered"],
    );
    expect(components.kind_changed).toEqual([
      { key: "app", before: ["manifest"], after: ["container", "manifest"] },
    ]);
    expect(components.gone).toEqual(["app/__proto__", "app/registered", "app/tmp"]);
    expect(components.unacknowledged).toEqual(["app", "app/svc", "app/web"]);
    expect(notFound).toEqual([]);
  });

  it("has no kind changes to give, a null that means so, when there is no previous record", async () => {
    const { components, notFound } = await against({ status: "none" }, ["package.json"], ["app/x"]);
    expect(components.kind_changed).toBeNull();
    expect(components.gone).toEqual(["app/x"]);
    expect(notFound).toEqual([]);
  });

  it("does not know what is gone or changed when the previous record cannot be read", async () => {
    const { components, notFound } = await against(
      { status: "unreadable", reason: "the record X could not be read as JSON" },
      ["package.json"],
      ["app/x"],
    );
    expect(components).toEqual({
      found: { app: { kinds: ["manifest"], status: "unacknowledged" } },
      unacknowledged: ["app"],
      gone: null,
      kind_changed: null,
    });
    expect(notFound).toEqual([
      {
        at: "components.gone",
        reason: "the record X could not be read as JSON, so a component only it found is not known",
      },
      { at: "components.kind_changed", reason: "the record X could not be read as JSON" },
    ]);
  });
});

describe("measureComponents: a registered component's own marker", () => {
  const marked = (
    paths: string[],
    registered: Record<string, { marker?: string }>,
    previous?: PreviousComponents,
  ) =>
    measureComponents({
      repos: ["."],
      names: new Map([[".", "app"]]),
      worktreeOf: tree(paths),
      registered,
      ...(previous === undefined ? {} : { previous }),
    });

  it("finds a registered directory when a file under it matches its marker from there", async () => {
    const { components, notFound } = await marked(
      [
        "content/a.md",
        "content/deep/b.md",
        "tools/run.py",
        "nested/sub/x.py",
        "lib/x.txt",
        "docs/README",
        "web/package.json",
      ],
      {
        "app/content": { marker: "**" },
        "app/tools": { marker: "*.py" },
        // '*' does not cross '/'.
        "app/nested": { marker: "*.py" },
        "app/lib": { marker: "*.md" },
        "app/web": { marker: "package.json" },
        "app/docs": {},
      },
    );
    expect(components.found).toEqual({
      "app/content": { kinds: ["marker"], status: "known" },
      "app/tools": { kinds: ["marker"], status: "known" },
      // Beside what a built-in marker finds there.
      "app/web": { kinds: ["manifest", "marker"], status: "known" },
    });
    expect(components.unacknowledged).toEqual([]);
    expect(components.gone).toEqual(["app/docs", "app/lib", "app/nested"]);
    expect(notFound).toEqual([]);
  });

  it("matches as an include does, by byte, from the component's directory", async () => {
    const { components } = await marked(
      [
        "a/deep/x.txt",
        "b/x/y/z.md",
        bytes("c/\u00e9.csv"),
        bytes("\u30c7\u30fc\u30bf/rows.csv"),
        "e/.hidden",
        "f/[x].txt",
      ],
      {
        // A literal path takes in what is under it.
        "app/a": { marker: "deep" },
        "app/b": { marker: "x/**/*.md" },
        // '?' is one byte, and the name is two.
        "app/c": { marker: "?.csv" },
        "app/\u30c7\u30fc\u30bf": { marker: "*.csv" },
        "app/e": { marker: "*" },
        "app/f": { marker: "\\[x\\].txt" },
      },
    );
    expect(Object.keys(components.found ?? {})).toEqual([
      "app/a",
      "app/b",
      "app/e",
      "app/f",
      "app/\u30c7\u30fc\u30bf",
    ]);
    expect(components.gone).toEqual(["app/c"]);
    const two = await marked([bytes("c/\u00e9.csv")], { "app/c": { marker: "??.csv" } });
    expect(two.components.found).toEqual({ "app/c": { kinds: ["marker"], status: "known" } });
  });

  it("finds nothing for a key that names a file, a repo itself or no repo, or only starts like a directory", async () => {
    const { components } = await marked(["README.md", "content/a.md", "contents.txt", "x/y/z.md"], {
      "app/README.md": { marker: "**" },
      "app/con": { marker: "**" },
      "app/x/y/z.md": { marker: "**" },
      app: { marker: "**" },
      "app/": { marker: "**" },
      "other/content": { marker: "**" },
    });
    expect(components.found).toEqual({});
    expect(components.gone).toEqual([
      "app",
      "app/",
      "app/README.md",
      "app/con",
      "app/x/y/z.md",
      "other/content",
    ]);
  });

  it("does not skip the directories the built-in markers skip", async () => {
    const { components } = await marked(
      ["vendor/lib/a.php", "web/node_modules/x/index.js", "web/dist/package.json"],
      { "app/vendor/lib": { marker: "*.php" }, "app/web": { marker: "**" } },
    );
    expect(components.found).toEqual({
      "app/vendor/lib": { kinds: ["marker"], status: "known" },
      "app/web": { kinds: ["marker"], status: "known" },
    });
  });

  it("looks in the repo the key names", async () => {
    const trees: Record<string, string[]> = { ".": ["data/a.md"], "../site": ["pages/b.md"] };
    const { components } = await measureComponents({
      repos: [".", "../site"],
      names: new Map([
        [".", "app"],
        ["../site", "site"],
      ]),
      worktreeOf: (repo) => tree(trees[repo] ?? [])(),
      registered: {
        "app/data": { marker: "*.md" },
        "app/pages": { marker: "*.md" },
        "site/pages": { marker: "*.md" },
        "site/data": { marker: "*.md" },
      },
    });
    expect(Object.keys(components.found ?? {})).toEqual(["app/data", "site/pages"]);
    expect(components.gone).toEqual(["app/pages", "site/data"]);
  });

  it("is a kind like any other against the previous record", async () => {
    const { components } = await marked(
      ["web/package.json", "content/a.md", "tools/x.sh"],
      { "app/web": { marker: "**" }, "app/content": { marker: "*.md" }, "app/tools": {} },
      {
        status: "found",
        found: {
          "app/web": { kinds: ["manifest"] },
          "app/content": { kinds: ["marker"] },
          "app/tools": { kinds: ["marker"] },
        },
      },
    );
    expect(components.kind_changed).toEqual([
      { key: "app/web", before: ["manifest"], after: ["manifest", "marker"] },
    ]);
    // Its marker taken off, a directory no built-in marker finds is gone.
    expect(components.gone).toEqual(["app/tools"]);
  });
});
