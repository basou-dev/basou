import { describe, expect, it } from "vitest";
import { measureComponents } from "./components.js";
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
