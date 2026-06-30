import { describe, expect, it } from "vitest";
import {
  buildStopHookCommand,
  findBasouStopHookCommand,
  isBasouStopHookCommand,
  removeStopHook,
  STOP_HOOK_TIMEOUT_SECONDS,
  upsertStopHook,
} from "./settings-hook.js";

const ENTRY = "/abs/basou/packages/cli/dist/index.js";

describe("buildStopHookCommand", () => {
  it("builds the advisory node-path command with the fail-open wrapper, path shell-quoted", () => {
    expect(buildStopHookCommand({ cliEntry: ENTRY })).toBe(
      `node '${ENTRY}' hook stop 2>/dev/null || true`,
    );
  });

  it("adds --block for the enforcement form", () => {
    expect(buildStopHookCommand({ cliEntry: ENTRY, block: true })).toBe(
      `node '${ENTRY}' hook stop --block 2>/dev/null || true`,
    );
  });

  it("adds --require-review for the opt-in review gate", () => {
    expect(buildStopHookCommand({ cliEntry: ENTRY, requireReview: true })).toBe(
      `node '${ENTRY}' hook stop --require-review 2>/dev/null || true`,
    );
  });

  it("orders flags --block, --require-review, --min-edits", () => {
    expect(
      buildStopHookCommand({ cliEntry: ENTRY, block: true, requireReview: true, minEdits: 3 }),
    ).toBe(`node '${ENTRY}' hook stop --block --require-review --min-edits 3 2>/dev/null || true`);
  });

  it("adds --min-edits when overridden, after --block", () => {
    expect(buildStopHookCommand({ cliEntry: ENTRY, block: true, minEdits: 3 })).toBe(
      `node '${ENTRY}' hook stop --block --min-edits 3 2>/dev/null || true`,
    );
  });

  it("escapes a single quote in the entry path", () => {
    expect(buildStopHookCommand({ cliEntry: "/a/o'brien/packages/cli/dist/index.js" })).toBe(
      `node '/a/o'\\''brien/packages/cli/dist/index.js' hook stop 2>/dev/null || true`,
    );
  });
});

describe("isBasouStopHookCommand", () => {
  it("recognizes the source-build node path (unquoted, with flags and wrapper)", () => {
    expect(isBasouStopHookCommand(`node ${ENTRY} hook stop --block 2>/dev/null || true`)).toBe(
      true,
    );
  });

  it("recognizes a shell-quoted path (the form install now writes)", () => {
    expect(isBasouStopHookCommand(buildStopHookCommand({ cliEntry: ENTRY }))).toBe(true);
    expect(
      isBasouStopHookCommand("node '/x/node_modules/@basou/cli/dist/index.js' hook stop"),
    ).toBe(true);
  });

  it("recognizes the npm-install node path", () => {
    expect(isBasouStopHookCommand("node /x/node_modules/@basou/cli/dist/index.js hook stop")).toBe(
      true,
    );
  });

  it("recognizes the basou alias form", () => {
    expect(isBasouStopHookCommand("basou hook stop")).toBe(true);
  });

  it("does NOT claim a foreign tool whose path merely ends in cli/dist/index.js", () => {
    // Would have matched the old bare `cli/dist/index.js` anchor — the bug that
    // could let uninstall delete a foreign hook.
    expect(isBasouStopHookCommand("node /x/some-cli/dist/index.js hook stop")).toBe(false);
    expect(isBasouStopHookCommand("node /x/their-cli/dist/index.js hook stop --block")).toBe(false);
  });

  it("does not match a foreign tool's hook stop, the installer wrapper, or basou's other commands", () => {
    expect(isBasouStopHookCommand("node /other/scripts/index.js hook stop")).toBe(false);
    expect(isBasouStopHookCommand("node /x/node_modules/basou/bin.mjs hook stop")).toBe(false);
    expect(isBasouStopHookCommand(`node ${ENTRY} orient`)).toBe(false);
    expect(isBasouStopHookCommand("basou note x")).toBe(false);
  });
});

describe("upsertStopHook", () => {
  const command = buildStopHookCommand({ cliEntry: ENTRY });

  it("installs into empty settings, creating the hooks.Stop scaffold", () => {
    const { settings, action } = upsertStopHook({}, command);
    expect(action).toBe("installed");
    expect(settings).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command, timeout: STOP_HOOK_TIMEOUT_SECONDS }] }],
      },
    });
  });

  it("treats null/undefined settings as a fresh object", () => {
    expect(upsertStopHook(null, command).action).toBe("installed");
    expect(upsertStopHook(undefined, command).action).toBe("installed");
  });

  it("preserves unrelated keys and a foreign SessionStart hook", () => {
    const before = {
      model: "opus",
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "node x orient" }] }],
      },
    };
    const { settings } = upsertStopHook(before, command);
    const s = settings as typeof before & {
      hooks: { Stop: unknown[]; SessionStart: unknown[] };
    };
    expect(s.model).toBe("opus");
    expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(s.hooks.SessionStart).toEqual(before.hooks.SessionStart);
    expect(s.hooks.Stop).toHaveLength(1);
  });

  it("upgrades an existing advisory basou hook to blocking in place (no duplicate)", () => {
    const advisory = buildStopHookCommand({ cliEntry: ENTRY });
    const blocking = buildStopHookCommand({ cliEntry: ENTRY, block: true });
    const installed = upsertStopHook({}, advisory).settings;
    const { settings, action } = upsertStopHook(installed, blocking);
    expect(action).toBe("updated");
    const stop = (settings as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } })
      .hooks.Stop;
    expect(stop).toHaveLength(1);
    expect(stop[0]?.hooks).toHaveLength(1);
    expect(stop[0]?.hooks[0]?.command).toBe(blocking);
  });

  it("upgrades a hand-written entry (different timeout / missing fields)", () => {
    const handWritten = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${ENTRY} hook stop` }] }] },
    };
    const { action, settings } = upsertStopHook(handWritten, command);
    expect(action).toBe("updated");
    const entry = (settings as { hooks: { Stop: Array<{ hooks: Array<{ timeout: number }> }> } })
      .hooks.Stop[0]?.hooks[0];
    expect(entry?.timeout).toBe(STOP_HOOK_TIMEOUT_SECONDS);
  });

  it("reports unchanged when the canonical entry already exists", () => {
    const installed = upsertStopHook({}, command).settings;
    expect(upsertStopHook(installed, command).action).toBe("unchanged");
  });

  it("does not mutate the input object", () => {
    const before = { hooks: { Stop: [] as unknown[] } };
    const snapshot = JSON.stringify(before);
    upsertStopHook(before, command);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("throws on a non-object settings root or malformed hooks/Stop", () => {
    expect(() => upsertStopHook([], command)).toThrow(/not a JSON object/);
    expect(() => upsertStopHook({ hooks: "x" }, command)).toThrow(/'hooks'.*not an object/);
    expect(() => upsertStopHook({ hooks: { Stop: "x" } }, command)).toThrow(/'hooks.Stop'.*array/);
  });
});

describe("removeStopHook", () => {
  const command = buildStopHookCommand({ cliEntry: ENTRY });

  it("removes the basou hook and prunes the emptied Stop / hooks scaffold", () => {
    const installed = upsertStopHook({}, command).settings;
    const { settings, action } = removeStopHook(installed);
    expect(action).toBe("removed");
    expect(settings).toEqual({});
  });

  it("reports absent when no basou hook is present", () => {
    expect(removeStopHook({}).action).toBe("absent");
    expect(removeStopHook({ hooks: { Stop: [] } }).action).toBe("absent");
    expect(
      removeStopHook({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "node x hook stop-other" }] }] },
      }).action,
    ).toBe("absent");
  });

  it("keeps a foreign hook in the same group, dropping only the basou entry", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "node /foreign/index.js audit" },
              { type: "command", command },
            ],
          },
        ],
      },
    };
    const { settings: out, action } = removeStopHook(settings);
    expect(action).toBe("removed");
    const stop = (out as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }).hooks
      .Stop;
    expect(stop).toHaveLength(1);
    expect(stop[0]?.hooks).toEqual([{ type: "command", command: "node /foreign/index.js audit" }]);
  });

  it("preserves a foreign SessionStart hook when removing Stop", () => {
    const settings = {
      hooks: {
        SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "node x orient" }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
      },
    };
    const { settings: out } = removeStopHook(settings);
    const s = out as { hooks: { SessionStart?: unknown; Stop?: unknown } };
    expect(s.hooks.SessionStart).toBeDefined();
    expect(s.hooks.Stop).toBeUndefined();
  });

  it("does not mutate the input object", () => {
    const installed = upsertStopHook({}, command).settings;
    const snapshot = JSON.stringify(installed);
    removeStopHook(installed);
    expect(JSON.stringify(installed)).toBe(snapshot);
  });
});

describe("findBasouStopHookCommand", () => {
  it("returns the registered command, or null when absent / malformed", () => {
    const command = buildStopHookCommand({ cliEntry: ENTRY, block: true });
    const installed = upsertStopHook({}, command).settings;
    expect(findBasouStopHookCommand(installed)).toBe(command);
    expect(findBasouStopHookCommand({})).toBeNull();
    expect(findBasouStopHookCommand(null)).toBeNull();
    expect(findBasouStopHookCommand({ hooks: { Stop: "x" } })).toBeNull();
  });
});
