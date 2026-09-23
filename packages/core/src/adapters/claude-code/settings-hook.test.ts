import { describe, expect, it } from "vitest";
import {
  buildSessionStartHookCommand,
  SESSION_START_HOOK_MATCHER,
  SESSION_START_HOOK_TIMEOUT_SECONDS,
} from "../codex/hooks-json.js";
import {
  buildStopHookCommand,
  findBasouStopHookCommand,
  findClaudeSessionStartHooks,
  findUnrecognizedSessionStart,
  isBasouOrientSessionStartCommand,
  isBasouStopHookCommand,
  isClaudeSessionStartHookCommand,
  isClaudeSessionStartMalformed,
  removeClaudeSessionStartHook,
  removeStopHook,
  STOP_HOOK_TIMEOUT_SECONDS,
  upsertClaudeSessionStartHook,
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

describe("Claude SessionStart hook", () => {
  const SS = buildSessionStartHookCommand({ cliEntry: ENTRY });
  const canonical = { type: "command", command: SS, timeout: SESSION_START_HOOK_TIMEOUT_SECONDS };
  /** The form basou's own reference told Claude Code users to register by hand. */
  const ORIENT = `node ${ENTRY} orient 2>/dev/null || true`;
  const ss = (groups: unknown[]) => ({ hooks: { SessionStart: groups } });

  describe("isBasouOrientSessionStartCommand", () => {
    it.each([
      ["the documented node form", `node ${ENTRY} orient 2>/dev/null || true`],
      ["a single-quoted entry", `node '${ENTRY}' orient 2>/dev/null || true`],
      ["a double-quoted entry", `node "${ENTRY}" orient`],
      ["the npm path", "node /usr/lib/node_modules/@basou/cli/dist/index.js orient"],
      ["the bare alias", "basou orient"],
    ])("recognizes %s", (_label, command) => {
      expect(isBasouOrientSessionStartCommand(command)).toBe(true);
    });

    it.each([
      // A flag changes what the hook does; rewriting it would change behaviour.
      ["--quiet (writes the file, prints nothing)", "basou orient --quiet 2>/dev/null || true"],
      ["--refresh (imports first)", "basou orient --refresh"],
      ["a cd before it", "cd ~/work && basou orient"],
      ["a chain after it", "basou orient && echo done"],
      ["a second command on the next line", "basou orient\necho next"],
      ["a foreign cli path", "node /x/some-cli/dist/index.js orient"],
      ["a path that merely ends in packages", "node /w/subpackages/cli/dist/index.js orient"],
      ["a different subcommand", "basou refresh"],
      ["hook session-start", SS],
    ])("does not claim %s", (_label, command) => {
      expect(isBasouOrientSessionStartCommand(command)).toBe(false);
    });
  });

  describe("isClaudeSessionStartHookCommand", () => {
    it("recognizes the command basou writes", () => {
      expect(isClaudeSessionStartHookCommand(SS)).toBe(true);
    });

    it("does not claim `hook session-start` inside a longer command", () => {
      // Rewriting it wholesale would delete the `cd` and the `echo`.
      expect(isClaudeSessionStartHookCommand(`cd /x && ${SS} && echo done`)).toBe(false);
    });
  });

  describe("upsertClaudeSessionStartHook", () => {
    it("installs a group of its own, with basou's matcher", () => {
      const { settings, action } = upsertClaudeSessionStartHook(undefined, SS);
      expect(action).toBe("installed");
      expect(settings).toEqual(ss([{ matcher: SESSION_START_HOOK_MATCHER, hooks: [canonical] }]));
    });

    it("leaves the Stop hook and every other key alone", () => {
      const before = {
        model: "x",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] },
      };
      const { settings } = upsertClaudeSessionStartHook(before, SS);
      expect(settings.model).toBe("x");
      expect((settings.hooks as Record<string, unknown>).Stop).toEqual(before.hooks.Stop);
    });

    it("is unchanged on a second run", () => {
      const once = upsertClaudeSessionStartHook(undefined, SS).settings;
      const twice = upsertClaudeSessionStartHook(once, SS);
      expect(twice.action).toBe("unchanged");
      expect(twice.settings).toEqual(once);
    });

    it("replaces the hand-registered `basou orient` in place, keeping its matcher", () => {
      const { settings, action } = upsertClaudeSessionStartHook(
        ss([{ matcher: "*", hooks: [{ type: "command", command: ORIENT, timeout: 20 }] }]),
        SS,
      );
      expect(action).toBe("replaced");
      expect(settings).toEqual(ss([{ matcher: "*", hooks: [canonical] }]));
    });

    it("reports `replaced` even when the orient it rewrote came after a canonical entry", () => {
      const { action } = upsertClaudeSessionStartHook(
        ss([
          { matcher: "startup", hooks: [{ ...canonical }] },
          { matcher: "resume", hooks: [{ type: "command", command: ORIENT }] },
        ]),
        SS,
      );
      expect(action).toBe("replaced");
    });

    it("updates an out-of-date `hook session-start` entry in place", () => {
      const stale = `node '/old/packages/cli/dist/index.js' hook session-start 2>/dev/null || true`;
      const { settings, action } = upsertClaudeSessionStartHook(
        ss([{ hooks: [{ type: "command", command: stale, timeout: 20 }] }]),
        SS,
      );
      expect(action).toBe("updated");
      expect(settings).toEqual(ss([{ hooks: [canonical] }]));
    });

    it("reports an update, not 'unchanged', when only the timeout is stale", () => {
      const { action } = upsertClaudeSessionStartHook(
        ss([{ hooks: [{ type: "command", command: SS, timeout: 20 }] }]),
        SS,
      );
      expect(action).toBe("updated");
    });

    it("collapses entries only under the SAME matcher", () => {
      const { settings, action } = upsertClaudeSessionStartHook(
        ss([
          { matcher: "*", hooks: [{ ...canonical }] },
          { hooks: [{ type: "command", command: SS }] }, // no matcher = "*"
        ]),
        SS,
      );
      expect(action).toBe("updated");
      expect(settings).toEqual(ss([{ matcher: "*", hooks: [canonical] }]));
    });

    it("keeps entries under different matchers, so no session source stops firing", () => {
      const { settings, action } = upsertClaudeSessionStartHook(
        ss([
          { matcher: "startup", hooks: [{ type: "command", command: ORIENT }] },
          { matcher: "resume|clear", hooks: [{ type: "command", command: SS }] },
        ]),
        SS,
      );
      expect(action).toBe("replaced");
      expect(settings).toEqual(
        ss([
          { matcher: "startup", hooks: [canonical] },
          { matcher: "resume|clear", hooks: [canonical] },
        ]),
      );
      expect(findClaudeSessionStartHooks(settings).map((h) => h.matcher)).toEqual([
        "startup",
        "resume|clear",
      ]);
    });

    it("never deletes the rest of a group it shares with a foreign hook", () => {
      const foreign = { type: "command", command: "echo hello" };
      const { settings } = upsertClaudeSessionStartHook(
        ss([{ matcher: "startup", hooks: [foreign, { type: "command", command: ORIENT }] }]),
        SS,
      );
      expect(settings).toEqual(ss([{ matcher: "startup", hooks: [foreign, canonical] }]));
    });

    it.each([
      ["orient inside a longer command", "cd ~/work && basou orient", "orient"],
      ["orient with a flag", "basou orient --quiet 2>/dev/null || true", "orient"],
      [
        "session-start inside a longer command",
        "cd /x && basou hook session-start && echo done",
        "session-start",
      ],
    ])("does not rewrite %s", (_label, command, runs) => {
      const other = { type: "command", command };
      const { settings, action } = upsertClaudeSessionStartHook(ss([{ hooks: [other] }]), SS);
      expect(action).toBe("installed");
      const groups = (settings.hooks as { SessionStart: unknown[] }).SessionStart;
      expect(groups[0]).toEqual({ hooks: [other] });
      expect(groups).toHaveLength(2);
      expect(findUnrecognizedSessionStart(settings)).toEqual([{ command, runs }]);
    });

    it("leaves an empty group it did not empty", () => {
      const { settings } = upsertClaudeSessionStartHook(ss([{ hooks: [] }]), SS);
      expect((settings.hooks as { SessionStart: unknown[] }).SessionStart[0]).toEqual({
        hooks: [],
      });
    });

    it("refuses a SessionStart that is not an array rather than replacing it", () => {
      const bad = { hooks: { SessionStart: {} } };
      expect(() => upsertClaudeSessionStartHook(bad, SS)).toThrow("'hooks.SessionStart'");
      expect(isClaudeSessionStartMalformed(bad)).toBe(true);
      expect(isClaudeSessionStartMalformed(ss([]))).toBe(false);
      expect(isClaudeSessionStartMalformed({})).toBe(false);
    });
  });

  describe("removeClaudeSessionStartHook", () => {
    it("removes both basou forms and the scaffolding they leave empty", () => {
      const { settings, action } = removeClaudeSessionStartHook(
        ss([
          { matcher: "*", hooks: [{ type: "command", command: ORIENT }] },
          { hooks: [{ type: "command", command: SS }] },
        ]),
      );
      expect(action).toBe("removed");
      expect(settings).toEqual({});
    });

    it("keeps foreign hooks, the Stop hook, and a compound command it does not own", () => {
      const compound = { type: "command", command: "cd ~/work && basou orient" };
      const stop = [{ hooks: [{ type: "command", command: "x" }] }];
      const { settings } = removeClaudeSessionStartHook({
        hooks: {
          Stop: stop,
          SessionStart: [{ hooks: [compound, { type: "command", command: SS }] }],
        },
      });
      expect(settings).toEqual({ hooks: { Stop: stop, SessionStart: [{ hooks: [compound] }] } });
    });

    it("reports absent when there is nothing of basou's", () => {
      expect(removeClaudeSessionStartHook({ hooks: {} }).action).toBe("absent");
    });
  });

  describe("findClaudeSessionStartHooks", () => {
    it("lists every basou entry with its form and matcher, in file order", () => {
      expect(
        findClaudeSessionStartHooks(
          ss([
            { matcher: "*", hooks: [{ type: "command", command: ORIENT }] },
            { hooks: [{ type: "command", command: SS }] },
          ]),
        ),
      ).toEqual([
        { command: ORIENT, kind: "orient", matcher: "*" },
        { command: SS, kind: "session-start", matcher: undefined },
      ]);
    });

    it("returns nothing when neither form is present", () => {
      expect(findClaudeSessionStartHooks({ hooks: { Stop: [] } })).toEqual([]);
    });
  });

  describe("findUnrecognizedSessionStart", () => {
    it.each([
      ["node options before the entry", `node --no-warnings '${ENTRY}' orient`, "orient"],
      ["npx", "npx @basou/cli orient", "orient"],
      ["npx -y", "npx -y @basou/cli hook session-start", "session-start"],
      ["a cd before it", "cd ~/work && basou orient", "orient"],
    ])("reports %s", (_label, command, runs) => {
      expect(findUnrecognizedSessionStart(ss([{ hooks: [{ type: "command", command }] }]))).toEqual(
        [{ command, runs }],
      );
    });

    it.each([
      ["the documented form, which install recognizes", ORIENT],
      ["basou's own command", SS],
      ["a quoted string that mentions it", "echo 'run basou orient later'"],
      ["the tail of another word", "notbasou orient"],
      ["another subcommand that starts the same", "basou orient-foo"],
    ])("does not report %s", (_label, command) => {
      expect(findUnrecognizedSessionStart(ss([{ hooks: [{ type: "command", command }] }]))).toEqual(
        [],
      );
    });
  });
});
