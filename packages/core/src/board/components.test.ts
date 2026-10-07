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
