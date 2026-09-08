import { describe, expect, it } from "vitest";
import {
  buildSessionStartHookCommand,
  findBasouSessionStartHook,
  isBasouSessionStartHookCommand,
  removeSessionStartHook,
  SESSION_START_HOOK_CONTEXT_LIMIT,
  SESSION_START_HOOK_MATCHER,
  SESSION_START_HOOK_TIMEOUT_SECONDS,
  upsertSessionStartHook,
} from "./hooks-json.js";

const entry = "/abs/basou/packages/cli/dist/index.js";
const cmd = buildSessionStartHookCommand({ cliEntry: entry });

describe("buildSessionStartHookCommand / isBasouSessionStartHookCommand", () => {
  it("builds a fail-open node-path command and recognizes it", () => {
    expect(cmd).toBe(`node '${entry}' hook session-start 2>/dev/null || true`);
    expect(isBasouSessionStartHookCommand(cmd)).toBe(true);
    expect(isBasouSessionStartHookCommand("basou hook session-start")).toBe(true);
    expect(
      isBasouSessionStartHookCommand(
        "node /x/node_modules/@basou/cli/dist/index.js hook session-start",
      ),
    ).toBe(true);
  });

  it("does not claim a foreign tool whose path merely ends in cli/dist/index.js, nor the Stop hook", () => {
    expect(
      isBasouSessionStartHookCommand("node /x/some-cli/dist/index.js hook session-start"),
    ).toBe(false);
    expect(isBasouSessionStartHookCommand(`node '${entry}' hook stop`)).toBe(false);
  });

  it("shell-quotes an entry path with a space", () => {
    const c = buildSessionStartHookCommand({ cliEntry: "/Users/a b/packages/cli/dist/index.js" });
    expect(c).toContain("'/Users/a b/packages/cli/dist/index.js'");
    expect(isBasouSessionStartHookCommand(c)).toBe(true);
  });
});

describe("upsertSessionStartHook", () => {
  it("installs into an absent file as its own matcher group with the canonical handler", () => {
    const { hooksFile, action } = upsertSessionStartHook(undefined, cmd);
    expect(action).toBe("installed");
    expect(hooksFile).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: SESSION_START_HOOK_MATCHER,
            hooks: [
              {
                type: "command",
                command: cmd,
                timeout: SESSION_START_HOOK_TIMEOUT_SECONDS,
                statusMessage: "basou orient",
                additionalContextLimit: SESSION_START_HOOK_CONTEXT_LIMIT,
              },
            ],
          },
        ],
      },
    });
  });

  it("preserves other events, a foreign SessionStart group, and unrelated keys", () => {
    const existing = {
      description: "mine",
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "lint" }] }],
      },
    };
    const { hooksFile, action } = upsertSessionStartHook(existing, cmd);
    expect(action).toBe("installed");
    const hooks = hooksFile.hooks as { SessionStart: unknown[]; PreToolUse: unknown[] };
    expect(hooksFile.description).toBe("mine");
    expect(hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
    // the input is not mutated
    expect(existing.hooks.SessionStart).toHaveLength(1);
  });

  it("is idempotent and upgrades a non-canonical basou handler in place", () => {
    const first = upsertSessionStartHook(undefined, cmd);
    const again = upsertSessionStartHook(first.hooksFile, cmd);
    expect(again.action).toBe("unchanged");
    expect(again.hooksFile).toEqual(first.hooksFile);

    const drifted = structuredClone(first.hooksFile) as {
      hooks: { SessionStart: Array<{ hooks: Array<Record<string, unknown>> }> };
    };
    const handler = drifted.hooks.SessionStart[0]?.hooks[0];
    if (handler === undefined) throw new Error("fixture");
    handler.timeout = 600;
    delete handler.additionalContextLimit;
    const upgraded = upsertSessionStartHook(drifted, cmd);
    expect(upgraded.action).toBe("updated");
    const h = (upgraded.hooksFile.hooks as typeof drifted.hooks).SessionStart[0]?.hooks[0];
    expect(h?.timeout).toBe(SESSION_START_HOOK_TIMEOUT_SECONDS);
    expect(h?.additionalContextLimit).toBe(SESSION_START_HOOK_CONTEXT_LIMIT);
    // an existing group's matcher is the operator's; the upgrade does not touch it
    expect((upgraded.hooksFile.hooks as typeof drifted.hooks).SessionStart).toHaveLength(1);
  });

  it("rewrites a basou handler registered under the dogfood source path", () => {
    const old = "node /home/me/projects/basou/packages/cli/dist/index.js hook session-start";
    const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: old }] }] } };
    const { hooksFile, action } = upsertSessionStartHook(existing, cmd);
    expect(action).toBe("updated");
    const groups = (
      hooksFile.hooks as { SessionStart: Array<{ hooks: Array<{ command: string }> }> }
    ).SessionStart;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hooks[0]?.command).toBe(cmd);
  });

  it("refuses a hooks.json that is not an object", () => {
    expect(() => upsertSessionStartHook([], cmd)).toThrow(/not a JSON object/);
    expect(() => upsertSessionStartHook({ hooks: 3 }, cmd)).toThrow(/'hooks'/);
    expect(() => upsertSessionStartHook({ hooks: { SessionStart: {} } }, cmd)).toThrow(
      /'hooks.SessionStart'/,
    );
  });
});

describe("removeSessionStartHook", () => {
  it("removes basou's handler and prunes the empty group, event and container", () => {
    const { hooksFile } = upsertSessionStartHook(undefined, cmd);
    const removed = removeSessionStartHook(hooksFile);
    expect(removed.action).toBe("removed");
    expect(removed.hooksFile).toEqual({});
  });

  it("keeps a foreign handler sharing basou's group, and other events", () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: cmd },
              { type: "command", command: "echo hi" },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "bye" }] }],
      },
    };
    const { hooksFile, action } = removeSessionStartHook(existing);
    expect(action).toBe("removed");
    expect(hooksFile).toEqual({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [{ hooks: [{ type: "command", command: "bye" }] }],
      },
    });
  });

  it("is a no-op when basou has no handler", () => {
    const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } };
    const { hooksFile, action } = removeSessionStartHook(existing);
    expect(action).toBe("absent");
    expect(hooksFile).toEqual(existing);
    expect(removeSessionStartHook(undefined).action).toBe("absent");
  });
});

describe("findBasouSessionStartHook", () => {
  it("returns the handler's position, matcher and installed fields", () => {
    const existing = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "other" }] },
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "x" },
              { type: "command", command: cmd, timeout: 30 },
            ],
          },
        ],
      },
    };
    const found = findBasouSessionStartHook(existing);
    expect(found).toEqual({
      command: cmd,
      groupIndex: 1,
      handlerIndex: 1,
      matcher: "startup",
      handler: { type: "command", command: cmd, timeout: 30 },
    });
  });

  it("returns null when absent or when the file is not an object", () => {
    expect(findBasouSessionStartHook(undefined)).toBeNull();
    expect(findBasouSessionStartHook({ hooks: {} })).toBeNull();
    expect(findBasouSessionStartHook("nope")).toBeNull();
  });
});
