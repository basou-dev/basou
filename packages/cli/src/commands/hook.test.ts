import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  PROTOCOL_END,
  PROTOCOL_START,
  parseProtocolStamp,
  readSessionObservation,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunCodexHookInstall,
  doRunCodexHookStatus,
  doRunCodexHookUninstall,
  doRunHookInstall,
  doRunHookSessionStart,
  doRunHookStatus,
  doRunHookStop,
  doRunHookUninstall,
  type HookInstallContext,
  type HookSessionStartContext,
  type HookStopContext,
  parseMinEdits,
  readTranscriptBounded,
  runHookInstall,
  runHookSessionStart,
} from "./hook.js";
import { doRunProtocolSync } from "./protocol.js";

/** A transcript line for one assistant message carrying N read-only Bash commands. */
function bashLine(n: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-24T00:00:00.000Z",
    message: {
      content: Array.from({ length: n }, (_, i) => ({
        type: "tool_use",
        name: "Bash",
        input: { command: `echo ${i}` },
      })),
    },
  });
}

/** A transcript line for one assistant message carrying N file edits. */
function editLine(n: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-24T00:00:00.000Z",
    message: {
      content: Array.from({ length: n }, (_, i) => ({
        type: "tool_use",
        name: "Edit",
        input: { file_path: `/x/f${i}.ts` },
      })),
    },
  });
}

/** A transcript line for one assistant message running a single Bash command. */
function cmdLine(command: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-24T00:00:00.000Z",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
  });
}

/**
 * A path inside this suite's own temp directory that nothing creates.
 *
 * The protocol-update gate reads the file the protocol block is rendered into
 * (`~/.claude/CLAUDE.md`) unless told otherwise, so every run below pins it
 * here and the suite stays hermetic. A fixed name in the shared tmpdir would
 * make "absent" an assumption about a directory other processes write to,
 * rather than a property of the suite.
 */
let absentProtocolTarget: string;
let hookSuiteDir: string;

beforeEach(async () => {
  hookSuiteDir = await mkdtemp(join(tmpdir(), "basou-hook-suite-"));
  absentProtocolTarget = join(hookSuiteDir, "absent-CLAUDE.md");
});

afterEach(async () => {
  await rm(hookSuiteDir, { recursive: true, force: true });
});

/**
 * Drive doRunHookStop with injected stdin + transcript, returning what it wrote.
 *
 * `transcript` feeds the capture / review gates through the injected reader;
 * the protocol gate reads `transcript_path` from disk for real (it needs the
 * HEAD of the file to date the session, and a full scan to dedupe), so a test
 * exercising it writes a real transcript and passes its path in `stdin`.
 */
async function run(
  stdin: unknown,
  transcript: string | { error: true },
  opts: { minEdits?: number; block?: boolean; requireReview?: boolean } = {},
  paths: { protocolTargetPath?: string } = {},
): Promise<string> {
  let out = "";
  const ctx: HookStopContext = {
    readStdin: async () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    readTranscript: async () => {
      if (typeof transcript !== "string") throw new Error("unreadable");
      return transcript;
    },
    write: (text) => {
      out += text;
    },
    protocolTargetPath: paths.protocolTargetPath ?? absentProtocolTarget,
    // The git observation has its own tests; injecting a no-op keeps these
    // hermetic (no real portfolio, no repository under the test's cwd).
    observe: async () => {},
  };
  await doRunHookStop(opts, ctx);
  return out;
}

function nudgeContext(out: string): string {
  expect(out.length).toBeGreaterThan(0);
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  return parsed.hookSpecificOutput.additionalContext;
}

describe("doRunHookStop", () => {
  it("emits a Stop additionalContext nudge for a substantive, uncaptured session", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [editLine(2)].join("\n"),
    );
    const context = nudgeContext(out);
    expect(context).toContain("basou decision capture");
    expect(context).toContain("basou note");
  });

  it("stays silent for a read-only Bash session (no edits / no strong signal)", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [bashLine(8)].join("\n"),
    );
    expect(out).toBe("");
  });

  it("stays silent when the session already captured", async () => {
    const transcript = [
      editLine(3),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "basou note x" } }],
        },
      }),
    ].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript);
    expect(out).toBe("");
  });

  it("stays silent when stop_hook_active is true (loop guard)", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: true },
      [editLine(5)].join("\n"),
    );
    expect(out).toBe("");
  });

  it("stays silent for a single trivial edit (below the edit threshold)", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [editLine(1)].join("\n"),
    );
    expect(out).toBe("");
  });

  it("respects a custom --min-edits threshold", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [editLine(1)].join("\n"),
      { minEdits: 1 },
    );
    expect(nudgeContext(out)).toContain("basou decision capture");
  });

  it("skips blank and malformed transcript lines without failing", async () => {
    const transcript = ["", "not json", editLine(2), "  ", "{bad"].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript);
    expect(nudgeContext(out)).toContain("basou decision capture");
  });

  it("fails open on empty stdin", async () => {
    const out = await run("", [editLine(2)].join("\n"));
    expect(out).toBe("");
  });

  it("fails open on malformed stdin JSON", async () => {
    const out = await run("{not json", [editLine(2)].join("\n"));
    expect(out).toBe("");
  });

  it("fails open when transcript_path is missing", async () => {
    const out = await run({ stop_hook_active: false }, [editLine(2)].join("\n"));
    expect(out).toBe("");
  });

  it("fails open when the transcript cannot be read", async () => {
    const out = await run(
      { transcript_path: "/missing.jsonl", stop_hook_active: false },
      { error: true },
    );
    expect(out).toBe("");
  });

  it("treats a missing stop_hook_active as not-active", async () => {
    const out = await run({ transcript_path: "/t.jsonl" }, [editLine(2)].join("\n"));
    expect(nudgeContext(out)).toContain("basou decision capture");
  });
});

describe("doRunHookStop --block (opt-in enforcement)", () => {
  it("emits a decision:block with the same reason text for a substantive session", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [editLine(2)].join("\n"),
      { block: true },
    );
    const parsed = JSON.parse(out) as { decision: string; reason: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("basou decision capture");
    // The blocking envelope carries no advisory hookSpecificOutput.
    expect(out).not.toContain("hookSpecificOutput");
  });

  it("still honors the loop guard (silent when stop_hook_active)", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: true },
      [editLine(5)].join("\n"),
      { block: true },
    );
    expect(out).toBe("");
  });

  it("stays silent for a non-substantive session even with --block", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      [bashLine(8)].join("\n"),
      { block: true },
    );
    expect(out).toBe("");
  });
});

describe("doRunHookStop --require-review (opt-in review gate)", () => {
  // A substantive-code session that shipped (git push) without a review record.
  const shippedTranscript = [editLine(2), cmdLine("git push origin main")].join("\n");

  it("ignores the review verdict by default (byte-identical capture-only output)", async () => {
    // Without --require-review, a shipped-without-review session that is also
    // already captured stays completely silent — the review verdict is not read.
    const transcript = [
      editLine(2),
      cmdLine("basou decision capture <<'JSON'\n[]\nJSON"),
      cmdLine("git push origin main"),
    ].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript);
    expect(out).toBe("");
  });

  it("emits a review nudge when a shipped session recorded no review", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      shippedTranscript,
      {
        requireReview: true,
      },
    );
    const context = nudgeContext(out);
    expect(context).toContain("basou review record");
    expect(context).toContain("shipped");
  });

  it("composes the capture and review nudges into one envelope when both fire", async () => {
    // Substantive + uncaptured (capture fires) AND shipped without review
    // (review fires) → a single envelope carrying both reminders.
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      shippedTranscript,
      {
        requireReview: true,
      },
    );
    const context = nudgeContext(out);
    expect(context).toContain("basou decision capture");
    expect(context).toContain("basou review record");
  });

  it("emits a review-ONLY nudge when capture is satisfied but the shipped session was not reviewed", async () => {
    // capture silent (already_captured via decision capture) + review fires
    // (shipped without a review record). This is the independent-gate case: the
    // review part must be emitted on its own, NOT gated behind a capture nudge —
    // a regression to the old `kind !== "nudge"` early return would drop it.
    const transcript = [
      editLine(2),
      cmdLine("basou decision capture <<'JSON'\n[]\nJSON"),
      cmdLine("git push origin main"),
    ].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript, {
      requireReview: true,
    });
    const context = nudgeContext(out);
    expect(context).toContain("basou review record");
    // Capture was satisfied, so its reminder must NOT appear.
    expect(context).not.toContain("basou decision capture");
  });

  it("stays silent when the shipped session already recorded a review", async () => {
    const transcript = [
      editLine(2),
      cmdLine("git push origin main"),
      cmdLine("basou review record --file r.json"),
      cmdLine("basou decision capture <<'JSON'\n[]\nJSON"),
    ].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript, {
      requireReview: true,
    });
    expect(out).toBe("");
  });

  it("blocks with the review reason under --require-review --block", async () => {
    const out = await run(
      { transcript_path: "/t.jsonl", stop_hook_active: false },
      shippedTranscript,
      {
        requireReview: true,
        block: true,
      },
    );
    const parsed = JSON.parse(out) as { decision: string; reason: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("basou review record");
    expect(out).not.toContain("hookSpecificOutput");
  });

  it("does not fire the review gate for a dry-run push", async () => {
    const transcript = [editLine(2), cmdLine("git push --dry-run")].join("\n");
    const out = await run({ transcript_path: "/t.jsonl", stop_hook_active: false }, transcript, {
      requireReview: true,
    });
    // Capture still fires (substantive + uncaptured), but the review part must not.
    const context = nudgeContext(out);
    expect(context).toContain("basou decision capture");
    expect(context).not.toContain("basou review record");
  });
});

describe("hook install / uninstall / status", () => {
  let dir: string;
  let settingsPath: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const cliEntry = "/abs/basou/packages/cli/dist/index.js";
  const ctx: HookInstallContext = { resolveCliEntry: () => cliEntry };
  const advisoryCmd = `node '${cliEntry}' hook stop 2>/dev/null || true`;
  const blockingCmd = `node '${cliEntry}' hook stop --block 2>/dev/null || true`;
  const reviewCmd = `node '${cliEntry}' hook stop --require-review 2>/dev/null || true`;
  const blockingReviewCmd = `node '${cliEntry}' hook stop --block --require-review 2>/dev/null || true`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-hook-install-"));
    settingsPath = join(dir, "settings.json");
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
  });
  afterEach(async () => {
    logSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  }

  it("installs the advisory hook into a non-existent settings.json", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const settings = (await readSettings()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(advisoryCmd);
    expect(settings.hooks.Stop[0]?.hooks[0]?.timeout).toBe(20);
    expect(logs.join("\n")).toContain("Installed");
  });

  it("preserves existing settings keys and a foreign SessionStart hook", async () => {
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          model: "opus",
          hooks: {
            SessionStart: [
              { matcher: "*", hooks: [{ type: "command", command: "node x orient" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const settings = (await readSettings()) as {
      model: string;
      hooks: { SessionStart: unknown[]; Stop: unknown[] };
    };
    expect(settings.model).toBe("opus");
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("is idempotent: re-installing the same mode reports no change", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    logs.length = 0;
    await doRunHookInstall({ settings: settingsPath }, ctx);
    expect(logs.join("\n")).toContain("already registered");
  });

  it("upgrades advisory -> blocking in place and writes a one-time backup", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    await doRunHookInstall({ settings: settingsPath, block: true }, ctx);
    const settings = (await readSettings()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(blockingCmd);
    // The backup preserves the pre-blocking (advisory) file.
    const backup = await readFile(`${settingsPath}.basou-bak`, "utf8");
    expect(backup).toContain(advisoryCmd);
  });

  it("status names the entry it runs, and asks that entry what build it is", async () => {
    // The reported harm: a hook ran a build a release and a half old for a
    // full day, and nothing said so — the wrapper swallows stderr on purpose,
    // so every turn is silent by design. `hook status` is the moment somebody
    // asks, so the answer belongs here.
    await doRunHookInstall({ settings: settingsPath }, ctx);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    const out = logs.join("\n");

    expect(out).toMatch(/the hook runs: .*index\.js/);
    // It ASKS the entry rather than reading a path or an mtime, so what comes
    // back is whatever that build says about itself.
    expect(out).toMatch(/that build is:/);
    // BOTH halves, always. The user's question is "is my hook current", which
    // needs two numbers; printing one and making them fetch the other by hand
    // is the second command this was supposed to save them.
    expect(out).toMatch(/this basou is: \d+\.\d+\.\d+/);
  });

  it("reports a REAL entry's build, not only the failure branch", async () => {
    // The suite's default cliEntry does not exist on disk, so every earlier
    // assertion about this feature was satisfied by the catch branch: the
    // success path -- the one line the feature exists to print -- was
    // unprotected, and gutting it left the whole suite green.
    const realEntry = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "dist",
      "index.js",
    );
    await doRunHookInstall({ settings: settingsPath }, { resolveCliEntry: () => realEntry });
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    const out = logs.join("\n");

    expect(out).toContain(`the hook runs: ${realEntry}`);
    expect(out).toMatch(/that build is: \d+\.\d+\.\d+/);
    expect(out).not.toContain("could not be executed");
  });

  it.each([
    ["a double-quoted entry", `node "ENTRY" hook stop 2>/dev/null || true`],
    ["node flags before the entry", `node --enable-source-maps 'ENTRY' hook stop`],
    ["an env assignment prefix", `BASOU_DEBUG=1 node 'ENTRY' hook stop`],
    ["an absolute interpreter", `/usr/local/bin/node 'ENTRY' hook stop`],
    ["leading whitespace", `   node 'ENTRY' hook stop`],
  ])("reads the entry out of %s", async (_label, shape) => {
    // Each of these is a shape `isBasouStopHookCommand` accepts. A regex over
    // the raw string got them wrong CONFIDENTLY -- the node-flag case reported
    // node's own version as "the build" and advised a rebuild.
    const realEntry = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "dist",
      "index.js",
    );
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const entry = parsed.hooks.Stop[0]?.hooks[0];
    if (entry === undefined) throw new Error("hook not registered");
    entry.command = shape.replace("ENTRY", realEntry);
    await writeFile(settingsPath, JSON.stringify(parsed, null, 2), "utf8");

    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    const out = logs.join("\n");
    expect(out).toContain(`the hook runs: ${realEntry}`);
    expect(out).toMatch(/that build is: \d+\.\d+\.\d+/);
  });

  it("reports the build on the Codex hook too, not only the Claude one", async () => {
    // The Codex handler carries the identical fail-open wrapper, and it is the
    // channel where a build too old to parse a newer event drops it line by
    // line — the asymmetry would have left the more consequential half silent.
    const realEntry = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "dist",
      "index.js",
    );
    const hooksPath = `${settingsPath}.codex-hooks.json`;
    await doRunCodexHookInstall({ hooks: hooksPath }, { resolveCliEntry: () => realEntry });
    logs.length = 0;
    await doRunCodexHookStatus({ hooks: hooksPath });
    const out = logs.join("\n");

    expect(out).toMatch(/this basou is: \d+\.\d+\.\d+/);
    expect(out).toContain(`the hook runs: ${realEntry}`);
    expect(out).toMatch(/that build is: \d+\.\d+\.\d+/);
  });

  it("says it cannot tell when the hook is registered by alias rather than by path", async () => {
    // The alias form is a shape basou itself recognizes, and no path can be
    // read out of it. Returning silently would print output identical to a
    // healthy hook's — the exact false reassurance this command exists to
    // remove.
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const entry = parsed.hooks.Stop[0]?.hooks[0];
    if (entry === undefined) throw new Error("hook not registered");
    entry.command = "basou hook stop 2>/dev/null || true";
    await writeFile(settingsPath, JSON.stringify(parsed, null, 2), "utf8");

    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    const out = logs.join("\n");
    expect(out).toContain("registered by alias");
    expect(out).toContain("cannot tell you");
  });

  it("status says so when the entry cannot be executed, instead of implying it works", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const entry = parsed.hooks.Stop[0]?.hooks[0];
    if (entry === undefined) throw new Error("hook not registered");
    entry.command = "node '/nonexistent/packages/cli/dist/index.js' hook stop 2>/dev/null || true";
    await writeFile(settingsPath, JSON.stringify(parsed, null, 2), "utf8");

    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    const out = logs.join("\n");
    expect(out).toContain("/nonexistent/packages/cli/dist/index.js");
    expect(out).toContain("silently doing nothing");
  });

  it("status reports advisory, then blocking, then not-registered", async () => {
    await doRunHookStatus({ settings: settingsPath });
    expect(logs.join("\n")).toContain("not registered");

    logs.length = 0;
    await doRunHookInstall({ settings: settingsPath }, ctx);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    expect(logs.join("\n")).toMatch(/registered.*advisory/);

    logs.length = 0;
    await doRunHookInstall({ settings: settingsPath, block: true }, ctx);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    expect(logs.join("\n")).toMatch(/registered.*blocking/);
  });

  it("registers the review tier with --require-review and reports it in status", async () => {
    await doRunHookInstall({ settings: settingsPath, requireReview: true }, ctx);
    const settings = (await readSettings()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(reviewCmd);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    // Capture-always-on; review added => "capture + review".
    expect(logs.join("\n")).toMatch(/registered.*advisory.*capture \+ review/);
  });

  it("registers blocking + review together with --block --require-review", async () => {
    await doRunHookInstall({ settings: settingsPath, block: true, requireReview: true }, ctx);
    const settings = (await readSettings()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(blockingReviewCmd);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    expect(logs.join("\n")).toMatch(/registered.*blocking.*capture \+ review/);
  });

  it("a capture-only install reports just 'capture' in status (no review tier)", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    const line = logs.join("\n");
    expect(line).toContain("capture");
    expect(line).not.toContain("review");
  });

  it("downgrades capture + review back to capture-only in place (no stale --require-review)", async () => {
    // The opt-in/off-by-default safety property: re-installing WITHOUT
    // --require-review over a review hook must drop the flag, not retain it.
    await doRunHookInstall({ settings: settingsPath, requireReview: true }, ctx);
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const settings = (await readSettings()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(advisoryCmd);
    logs.length = 0;
    await doRunHookStatus({ settings: settingsPath });
    expect(logs.join("\n")).not.toContain("review");
  });

  it("uninstall removes the basou hook and prunes empty scaffold", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    await doRunHookUninstall({ settings: settingsPath });
    expect(await readSettings()).toEqual({});
    expect(logs.join("\n")).toContain("Removed");
  });

  it("uninstall is a no-op when no basou hook is present", async () => {
    await writeFile(settingsPath, `${JSON.stringify({ model: "opus" }, null, 2)}\n`);
    await doRunHookUninstall({ settings: settingsPath });
    expect((await readSettings()).model).toBe("opus");
    expect(logs.join("\n")).toContain("nothing removed");
  });

  it("dry-run install does not write the file", async () => {
    await doRunHookInstall({ settings: settingsPath, dryRun: true }, ctx);
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
    expect(logs.join("\n")).toContain("[dry-run]");
  });
});

describe("parseMinEdits (lenient, fail-open)", () => {
  it("parses a valid non-negative integer", () => {
    expect(parseMinEdits("0")).toBe(0);
    expect(parseMinEdits("3")).toBe(3);
  });

  it("returns undefined (fall back to default) for invalid values, never throwing", () => {
    for (const bad of [undefined, "", "nope", "-1", "2.5", "1e3", " ", "NaN"]) {
      expect(parseMinEdits(bad)).toBeUndefined();
    }
  });
});

describe("readTranscriptBounded", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-hook-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the whole file when it is under the cap", async () => {
    const path = join(dir, "small.jsonl");
    const content = ["L0", "L1", "L2"].join("\n");
    await writeFile(path, content);
    expect(await readTranscriptBounded(path, 1024)).toBe(content);
  });

  it("reads only the trailing window and drops the first partial line when over the cap", async () => {
    const path = join(dir, "big.jsonl");
    // Each line is 11 bytes incl. newline; write 100 lines (~1100 bytes).
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
    await writeFile(path, `${lines.join("\n")}\n`);
    const tail = await readTranscriptBounded(path, 50);
    // The window is the last ~50 bytes; its first (partial) line is dropped, so
    // every returned line is a complete one and they are the final lines.
    expect(tail.length).toBeLessThanOrEqual(50);
    expect(tail).toContain("line-0099");
    expect(tail).not.toContain("line-0000");
    for (const line of tail.split("\n").filter((l) => l.length > 0)) {
      expect(line).toMatch(/^line-\d{4}$/);
    }
  });
});

describe("hook install/uninstall edge cases", () => {
  let dir: string;
  let settingsPath: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const cliEntry = "/abs/basou/packages/cli/dist/index.js";
  const ctx: HookInstallContext = { resolveCliEntry: () => cliEntry };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-hook-edge-"));
    settingsPath = join(dir, "settings.json");
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });
  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it("runHookInstall reports an error and exits non-zero on invalid settings JSON", async () => {
    await writeFile(settingsPath, "{ not valid json");
    await runHookInstall({ settings: settingsPath }, ctx);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("runHookInstall rejects an invalid --min-edits", async () => {
    await runHookInstall({ settings: settingsPath, minEdits: "nope" }, ctx);
    expect(process.exitCode).toBe(1);
    // Nothing was written because validation failed before any I/O.
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("registers a custom --min-edits in the command", async () => {
    await runHookInstall({ settings: settingsPath, minEdits: "5" }, ctx);
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(
      `node '${cliEntry}' hook stop --min-edits 5 2>/dev/null || true`,
    );
  });

  it("dry-run uninstall does not write", async () => {
    await doRunHookInstall({ settings: settingsPath }, ctx);
    const before = await readFile(settingsPath, "utf8");
    await doRunHookUninstall({ settings: settingsPath, dryRun: true });
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    expect(logs.join("\n")).toContain("[dry-run]");
  });
});

describe("hook handlers observe the session's file changes", () => {
  type Call = { pass: "baseline" | "changes"; sessionId: unknown };

  function spy(calls: Call[]) {
    return async (fields: Record<string, unknown>, pass: "baseline" | "changes") => {
      calls.push({ pass, sessionId: fields.session_id });
    };
  }

  it("Stop observes the changes for the session in the payload", async () => {
    const calls: Call[] = [];
    await doRunHookStop(
      {},
      {
        readStdin: async () =>
          JSON.stringify({ session_id: "sess-1", cwd: "/ws", transcript_path: "" }),
        readTranscript: async () => "",
        write: () => {},
        protocolTargetPath: absentProtocolTarget,
        observe: spy(calls),
      },
    );
    expect(calls).toEqual([{ pass: "changes", sessionId: "sess-1" }]);
  });

  it("Stop observes on a continuation turn too, where every nudge is suppressed", async () => {
    const calls: Call[] = [];
    await doRunHookStop(
      {},
      {
        readStdin: async () =>
          JSON.stringify({ session_id: "sess-1", cwd: "/ws", stop_hook_active: true }),
        readTranscript: async () => "",
        write: () => {},
        protocolTargetPath: absentProtocolTarget,
        observe: spy(calls),
      },
    );
    // The turn that answers a blocking nudge is often the one that captures the
    // decisions; its edits must not fall outside the observation.
    expect(calls).toEqual([{ pass: "changes", sessionId: "sess-1" }]);
  });

  it("Stop survives an observation that throws", async () => {
    let wrote = "";
    await expect(
      doRunHookStop(
        {},
        {
          readStdin: async () => JSON.stringify({ session_id: "s", cwd: "/ws" }),
          readTranscript: async () => "",
          write: (text) => {
            wrote += text;
          },
          protocolTargetPath: absentProtocolTarget,
          observe: async () => {
            throw new Error("git exploded");
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(wrote).toBe("");
  });

  it("SessionStart records the baseline before rendering the position", async () => {
    const order: string[] = [];
    await doRunHookSessionStart({
      readStdin: async () => JSON.stringify({ session_id: "sess-2", cwd: "/ws" }),
      write: () => {
        order.push("write");
      },
      render: async () => {
        order.push("render");
        return { body: "position" };
      },
      observe: async (_fields, pass) => {
        order.push(`observe:${pass}`);
      },
    });
    expect(order).toEqual(["observe:baseline", "render", "write"]);
  });

  it("SessionStart still records the baseline when the position stays silent", async () => {
    const calls: Call[] = [];
    await doRunHookSessionStart({
      readStdin: async () => JSON.stringify({ session_id: "sess-3", cwd: "/ws" }),
      write: () => {},
      render: async () => {
        throw new Error("not a registered workspace");
      },
      observe: spy(calls),
    });
    // The silence gates decide what a session HEARS; they say nothing about
    // whether basou may observe the operator's own store.
    expect(calls).toEqual([{ pass: "baseline", sessionId: "sess-3" }]);
  });

  it("observes nothing when the payload cannot be parsed", async () => {
    const calls: Call[] = [];
    await doRunHookSessionStart({
      readStdin: async () => "not json",
      write: () => {},
      render: async () => ({ body: "position" }),
      observe: spy(calls),
    });
    expect(calls).toEqual([]);
  });
});

describe("doRunHookSessionStart (Codex SessionStart handler)", () => {
  async function run(
    stdin: unknown,
    render: NonNullable<HookSessionStartContext["render"]>,
  ): Promise<string> {
    let out = "";
    await doRunHookSessionStart({
      readStdin: async () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
      write: (text) => {
        out += text;
      },
      render,
      observe: async () => {},
    });
    return out;
  }

  it("prints the position of the workspace at the payload's cwd, as plain text with one trailing newline", async () => {
    const seen: string[] = [];
    const out = await run(
      { session_id: "s", cwd: "/ws/planning", hook_event_name: "SessionStart", source: "startup" },
      async (cwd) => {
        seen.push(cwd);
        return { body: "# Orientation\n\nyou are here\n\n" };
      },
    );
    expect(seen).toEqual(["/ws/planning"]);
    expect(out).toBe("# Orientation\n\nyou are here\n");
    // Plain text, not a hook JSON envelope: Codex adds plain stdout as developer context.
    expect(out.startsWith("{")).toBe(false);
  });

  it("stays silent when the cwd is not a basou workspace (the renderer throws)", async () => {
    const out = await run({ cwd: "/" }, async () => {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou orient'.");
    });
    expect(out).toBe("");
  });

  it("stays silent on an empty, malformed, or cwd-less payload without calling the renderer", async () => {
    let calls = 0;
    const render = async () => {
      calls++;
      return { body: "x" };
    };
    expect(await run("", render)).toBe("");
    expect(await run("{ not json", render)).toBe("");
    expect(await run({ session_id: "s" }, render)).toBe("");
    expect(await run({ cwd: "" }, render)).toBe("");
    expect(await run([], render)).toBe("");
    expect(calls).toBe(0);
  });

  it("stays silent when the rendered body is empty", async () => {
    expect(await run({ cwd: "/ws" }, async () => ({ body: "   \n" }))).toBe("");
  });

  it("runHookSessionStart swallows a throwing stdin reader (fail-open)", async () => {
    await expect(
      runHookSessionStart({
        readStdin: async () => {
          throw new Error("boom");
        },
        write: () => {
          throw new Error("must not be called");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("hook install / uninstall / status codex", () => {
  let dir: string;
  let hooksPath: string;
  let configPath: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const cliEntry = "/abs/basou/packages/cli/dist/index.js";
  const ctx: HookInstallContext = { resolveCliEntry: () => cliEntry };
  const expectedCmd = `node '${cliEntry}' hook session-start 2>/dev/null || true`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-hook-codex-"));
    hooksPath = join(dir, "hooks.json");
    configPath = join(dir, "config.toml");
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
  });
  afterEach(async () => {
    logSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function readHooks(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(hooksPath, "utf8"));
  }

  it("installs the SessionStart hook into a non-existent hooks.json and says trust is still pending", async () => {
    await doRunCodexHookInstall({ hooks: hooksPath }, ctx);
    const file = (await readHooks()) as {
      hooks: {
        SessionStart: Array<{
          matcher: string;
          hooks: Array<{ command: string; timeout: number; additionalContextLimit: number }>;
        }>;
      };
    };
    expect(file.hooks.SessionStart).toHaveLength(1);
    expect(file.hooks.SessionStart[0]?.matcher).toBe("startup|resume|clear");
    expect(file.hooks.SessionStart[0]?.hooks[0]?.command).toBe(expectedCmd);
    expect(file.hooks.SessionStart[0]?.hooks[0]?.timeout).toBe(30);
    expect(file.hooks.SessionStart[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(logs.join("\n")).toContain("Installed");
    expect(logs.join("\n")).toContain("trust");
  });

  it("preserves a foreign SessionStart hook and other events, is idempotent, and backs up once", async () => {
    await writeFile(
      hooksPath,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] },
            ],
            Stop: [{ hooks: [{ type: "command", command: "bye" }] }],
          },
        },
        null,
        2,
      )}\n`,
    );
    await doRunCodexHookInstall({ hooks: hooksPath }, ctx);
    const file = (await readHooks()) as { hooks: { SessionStart: unknown[]; Stop: unknown[] } };
    expect(file.hooks.SessionStart).toHaveLength(2);
    expect(file.hooks.Stop).toHaveLength(1);
    expect(await readFile(`${hooksPath}.basou-bak`, "utf8")).toContain("echo hi");

    logs.length = 0;
    await doRunCodexHookInstall({ hooks: hooksPath }, ctx);
    expect(logs.join("\n")).toContain("already registered");
  });

  it("dry-run install does not write", async () => {
    await doRunCodexHookInstall({ hooks: hooksPath, dryRun: true }, ctx);
    await expect(readFile(hooksPath, "utf8")).rejects.toThrow();
    expect(logs.join("\n")).toContain("[dry-run]");
  });

  it("status reports not registered, then untrusted, then trusted once config.toml records the matching hash", async () => {
    await doRunCodexHookStatus({ hooks: hooksPath, codexConfig: configPath });
    expect(logs.join("\n")).toContain("not registered");

    logs.length = 0;
    await doRunCodexHookInstall({ hooks: hooksPath }, ctx);
    logs.length = 0;
    await doRunCodexHookStatus({ hooks: hooksPath, codexConfig: configPath });
    expect(logs.join("\n")).toContain("registered");
    expect(logs.join("\n")).toContain("not yet trusted");

    // Record the trust the way Codex does: the identity hash of what is installed,
    // keyed by the file position.
    const installed = (await readHooks()) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> };
    };
    const handler = installed.hooks.SessionStart[0]?.hooks[0];
    if (handler === undefined) throw new Error("fixture");
    const { computeCodexHookIdentityHash, commandHandlerFields, codexHookStateKey } = await import(
      "../lib/codex-hook-trust.js"
    );
    const fields = commandHandlerFields(handler);
    if (fields === null) throw new Error("fixture");
    const hash = computeCodexHookIdentityHash({
      eventKey: "session_start",
      matcher: installed.hooks.SessionStart[0]?.matcher,
      handler: fields,
    });
    const key = codexHookStateKey(hooksPath, "session_start", 0, 0);
    await writeFile(
      configPath,
      `model = "x"\n\n[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`,
    );

    logs.length = 0;
    await doRunCodexHookStatus({ hooks: hooksPath, codexConfig: configPath });
    expect(logs.join("\n")).toContain("trusted by Codex");
    expect(logs.join("\n")).not.toContain("not yet trusted");

    // A changed handler is "modified" against the recorded hash.
    handler.timeout = 31;
    await writeFile(hooksPath, `${JSON.stringify(installed, null, 2)}\n`);
    logs.length = 0;
    await doRunCodexHookStatus({ hooks: hooksPath, codexConfig: configPath });
    expect(logs.join("\n")).toContain("does not match what basou computes");
  });

  it("uninstall removes the hook, prunes scaffold, and is a no-op when absent", async () => {
    await doRunCodexHookInstall({ hooks: hooksPath }, ctx);
    logs.length = 0;
    await doRunCodexHookUninstall({ hooks: hooksPath });
    expect(await readHooks()).toEqual({});
    expect(logs.join("\n")).toContain("Removed");

    logs.length = 0;
    await doRunCodexHookUninstall({ hooks: hooksPath });
    expect(logs.join("\n")).toContain("nothing removed");
  });
});

describe("the production observer, against a real workspace", () => {
  const execFileAsync = promisify(execFile);
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
  let dir: string;
  let repo: string;
  let portfolioPath: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "basou-hook-observe-")));
    repo = join(dir, "ws");
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo], { env: ENV });
    await execFileAsync("git", ["-C", repo, "config", "user.email", "t@example.com"], { env: ENV });
    await execFileAsync("git", ["-C", repo, "config", "user.name", "t"], { env: ENV });
    await writeFile(join(repo, "README.md"), "# init\n");
    await execFileAsync("git", ["-C", repo, "add", "README.md"], { env: ENV });
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "initial"], { env: ENV });
    const paths = await ensureBasouDirectory(repo);
    await writeManifest(
      paths,
      createManifest({
        workspaceName: "ws",
        now: new Date("2026-09-22T03:00:00.000Z"),
        workspaceId: "ws_01HXABCDEF1234567890ABCDEF",
      }),
    );
    portfolioPath = join(dir, "portfolio.yaml");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Fire SessionStart, then Stop, for one session id — the real observer. */
  async function fireBoth(sessionId: string, cwd: string): Promise<void> {
    await doRunHookSessionStart({
      readStdin: async () => JSON.stringify({ session_id: sessionId, cwd, source: "startup" }),
      write: () => {},
      portfolioConfigPath: portfolioPath,
      render: async () => ({ body: "" }),
    });
    await doRunHookStop(
      {},
      {
        readStdin: async () => JSON.stringify({ session_id: sessionId, cwd }),
        readTranscript: async () => "",
        write: () => {},
        protocolTargetPath: absentProtocolTarget,
        portfolioConfigPath: portfolioPath,
      },
    );
  }

  it("records a file written by a shell command, which no transcript names", async () => {
    await writeFile(portfolioPath, `workspaces:\n  - path: ${JSON.stringify(repo)}\n`);
    await doRunHookSessionStart({
      readStdin: async () => JSON.stringify({ session_id: "sess-1", cwd: repo }),
      write: () => {},
      portfolioConfigPath: portfolioPath,
      render: async () => ({ body: "" }),
    });
    // The session does its work through the shell: no editing tool is involved.
    await writeFile(join(repo, "written.ts"), "export const a = 1;\n");
    await doRunHookStop(
      {},
      {
        readStdin: async () => JSON.stringify({ session_id: "sess-1", cwd: repo }),
        readTranscript: async () => "",
        write: () => {},
        protocolTargetPath: absentProtocolTarget,
        portfolioConfigPath: portfolioPath,
      },
    );

    const stored = await readSessionObservation(basouPaths(repo).observations, "sess-1");
    expect(stored?.repos[0]?.files.map((f) => f.path)).toEqual([join(repo, "written.ts")]);
  });

  it("writes nothing for a workspace the operator has not registered", async () => {
    await writeFile(portfolioPath, "workspaces:\n  - path: /somewhere/else\n");
    await fireBoth("sess-2", repo);
    expect(await readSessionObservation(basouPaths(repo).observations, "sess-2")).toBeNull();
  });

  it("writes nothing when the payload carries no session id", async () => {
    await writeFile(portfolioPath, `workspaces:\n  - path: ${JSON.stringify(repo)}\n`);
    await doRunHookSessionStart({
      readStdin: async () => JSON.stringify({ cwd: repo }),
      write: () => {},
      portfolioConfigPath: portfolioPath,
      render: async () => ({ body: "" }),
    });
    // The directory exists (every store has it); what matters is that the hook
    // wrote no observation into it.
    expect(await readdir(basouPaths(repo).observations)).toEqual([]);
  });
});

describe("hook session-start against a real workspace (allowlist, no write)", () => {
  const execFileAsync = promisify(execFile);
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
  let dir: string;
  let repo: string;
  let portfolioPath: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "basou-hook-ws-")));
    repo = join(dir, "ws");
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo], { env: ENV });
    const paths = await ensureBasouDirectory(repo);
    await writeManifest(
      paths,
      createManifest({
        workspaceName: "ws",
        now: new Date("2026-05-09T03:00:00.000Z"),
        workspaceId: "ws_01HXABCDEF1234567890ABCDEF",
      }),
    );
    portfolioPath = join(dir, "portfolio.yaml");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fire(cwd: string): Promise<string> {
    let out = "";
    await doRunHookSessionStart({
      readStdin: async () => JSON.stringify({ session_id: "s", cwd, source: "startup" }),
      write: (t) => {
        out += t;
      },
      portfolioConfigPath: portfolioPath,
      observe: async () => {},
    });
    return out;
  }

  it("prints the position of a REGISTERED workspace and writes no orientation.md", async () => {
    await writeFile(portfolioPath, `workspaces:\n  - path: ${JSON.stringify(repo)}\n`);
    const out = await fire(repo);
    expect(out).toContain("# Orientation");
    expect(out.endsWith("\n")).toBe(true);
    await expect(access(basouPaths(repo).files.orientation)).rejects.toThrow();
  });

  it("stays silent for a workspace that is NOT registered, even though it has a store", async () => {
    await writeFile(portfolioPath, "workspaces:\n  - path: /somewhere/else\n");
    expect(await fire(repo)).toBe("");
    await expect(access(basouPaths(repo).files.orientation)).rejects.toThrow();
  });

  it("stays silent when there is no portfolio registry at all", async () => {
    expect(await fire(repo)).toBe("");
  });

  it("stays silent for a directory that is not a git repository", async () => {
    await writeFile(portfolioPath, `workspaces:\n  - path: ${JSON.stringify(repo)}\n`);
    expect(await fire(dir)).toBe("");
  });

  /** A completed session whose recorded files are `relatedFiles` — what the position lists as recent files. */
  async function placeSession(relatedFiles: string[]): Promise<void> {
    const paths = basouPaths(repo);
    const id = "ses_01HXABCDEF1234567890ABCF01";
    const sessionDir = join(paths.sessions, id);
    await mkdir(sessionDir, { recursive: true });
    await writeYamlFile(join(sessionDir, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id,
        label: "fixture",
        task_id: null,
        workspace_id: "ws_01HXABCDEF1234567890ABCDEF",
        source: { kind: "claude-code-import", version: "0.1.0" },
        started_at: "2026-05-08T11:00:00+09:00",
        status: "completed",
        working_directory: repo,
        invocation: { command: "echo", args: [], exit_code: 0 },
        related_files: relatedFiles,
        events_log: "events.jsonl",
      },
    });
  }

  // The second gate: a position that names another registered workspace is
  // withheld, not handed over. On `orient` / `refresh` the same finding is a
  // stderr advisory; here nobody reads stderr and the body would become the
  // session's trusted context, so silence is the only outcome that keeps the
  // name out.
  it("stays silent when the position names another registered workspace", async () => {
    const other = join(dir, "beta-planning");
    await writeFile(
      portfolioPath,
      `workspaces:\n  - path: ${JSON.stringify(repo)}\n  - path: ${JSON.stringify(other)}\n`,
    );
    await placeSession([join(other, "notes.md")]);
    expect(await fire(repo)).toBe("");
    await expect(access(basouPaths(repo).files.orientation)).rejects.toThrow();
  });

  // A registry may also list the workspace's own view (`basou view --check`
  // calls that `redundant`). It is another spelling of the self, not a foreign
  // workspace, so a file recorded through the view must not silence the hook.
  it("still prints when the registry also lists the workspace's own view", async () => {
    const view = join(dir, "ws-workspace");
    await mkdir(view);
    await symlink(repo, join(view, "ws"));
    await writeFile(
      portfolioPath,
      `workspaces:\n  - path: ${JSON.stringify(repo)}\n  - path: ${JSON.stringify(view)}\n`,
    );
    await placeSession([join(view, "ws", "notes.md")]);
    const out = await fire(repo);
    expect(out).toContain("# Orientation");
    expect(out).toContain("notes.md");
  });

  it("still prints when other workspaces are registered but the position names none", async () => {
    const other = join(dir, "beta-planning");
    await writeFile(
      portfolioPath,
      `workspaces:\n  - path: ${JSON.stringify(repo)}\n  - path: ${JSON.stringify(other)}\n`,
    );
    await placeSession([join(repo, "notes.md")]);
    const out = await fire(repo);
    expect(out).toContain("# Orientation");
    expect(out).toContain("notes.md");
  });
});

describe("hook install / status codex: trust line, leftover face block, unchanged reinstall", () => {
  let dir: string;
  let hooksPath: string;
  let configPath: string;
  let facePath: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const cliEntry = "/abs/basou/packages/cli/dist/index.js";
  const ctx: HookInstallContext = { resolveCliEntry: () => cliEntry };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-hook-codex2-"));
    hooksPath = join(dir, "hooks.json");
    configPath = join(dir, "config.toml");
    facePath = join(dir, "AGENTS.md");
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
  });
  afterEach(async () => {
    logSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("install ends with the Codex trust verdict", async () => {
    await doRunCodexHookInstall(
      { hooks: hooksPath, codexConfig: configPath, codexFace: facePath },
      ctx,
    );
    expect(logs.join("\n")).toContain("Codex trust: not yet trusted");
  });

  it("install and status point at a leftover orientation block in the face, and stay quiet without one", async () => {
    await writeFile(
      facePath,
      "# notes\n<!-- BASOU:ORIENTATION:START -->\nold position\n<!-- BASOU:ORIENTATION:END -->\n",
    );
    await doRunCodexHookInstall(
      { hooks: hooksPath, codexConfig: configPath, codexFace: facePath },
      ctx,
    );
    expect(logs.join("\n")).toContain("basou channel clear codex");
    expect(logs.join("\n")).toContain("earlier basou");

    logs.length = 0;
    await doRunCodexHookStatus({ hooks: hooksPath, codexConfig: configPath, codexFace: facePath });
    expect(logs.join("\n")).toContain("basou channel clear codex");

    logs.length = 0;
    await writeFile(facePath, "# notes only\n");
    await doRunCodexHookStatus({ hooks: hooksPath, codexConfig: configPath, codexFace: facePath });
    expect(logs.join("\n")).not.toContain("channel clear");
  });

  it("a reformat-only reinstall neither rewrites the file nor takes a backup nor asks to re-trust", async () => {
    await doRunCodexHookInstall(
      { hooks: hooksPath, codexConfig: configPath, codexFace: facePath },
      ctx,
    );
    const canonical = JSON.parse(await readFile(hooksPath, "utf8")) as unknown;
    const fourSpace = `${JSON.stringify(canonical, null, 4)}\n`;
    await writeFile(hooksPath, fourSpace);
    logs.length = 0;
    await doRunCodexHookInstall(
      { hooks: hooksPath, codexConfig: configPath, codexFace: facePath },
      ctx,
    );
    expect(await readFile(hooksPath, "utf8")).toBe(fourSpace);
    await expect(access(`${hooksPath}.basou-bak`)).rejects.toThrow();
    expect(logs.join("\n")).toContain("already registered");
    expect(logs.join("\n")).not.toContain("Updated");
  });
});

describe("doRunHookStop — the protocol-update gate", () => {
  let pdir: string;
  let pconfig: string;
  let psource: string;
  let ptarget: string;
  let tpath: string;

  /** Write a real transcript file whose first record dates the session start. */
  async function transcript(startedAt: string, extra: string[] = []): Promise<string> {
    const lines = [JSON.stringify({ type: "user", timestamp: startedAt }), ...extra];
    await writeFile(tpath, `${lines.join("\n")}\n`);
    return lines.join("\n");
  }

  /** Sync the declared protocols into `ptarget`, stamping at the current time. */
  async function sync(): Promise<void> {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await doRunProtocolSync({ config: pconfig, target: ptarget });
    log.mockRestore();
  }

  /**
   * Sync the current protocols and return a session start dated at that sync.
   *
   * Using the baseline stamp's own date is what makes these tests mean what
   * they say: a session that started THEN has read exactly this block, so a
   * later delivery can only be something that changed afterwards. A wall-clock
   * "a minute ago" would sit before the baseline sync too, and every case would
   * pass by delivering the baseline.
   */
  async function syncAndStart(): Promise<string> {
    await sync();
    const stamp = parseProtocolStamp(await readFile(ptarget, "utf8"));
    if (stamp === null) throw new Error("expected the synced block to carry a stamp");
    return stamp.changedAt;
  }

  /** Drive the Stop hook against this test's real transcript file and target. */
  function runGate(body: string, opts: { block?: boolean } = {}): Promise<string> {
    return run({ transcript_path: tpath, stop_hook_active: false }, body, opts, {
      protocolTargetPath: ptarget,
    });
  }

  beforeEach(async () => {
    pdir = await mkdtemp(join(tmpdir(), "basou-hook-protocol-"));
    psource = join(pdir, "capture.md");
    pconfig = join(pdir, "protocols.yaml");
    ptarget = join(pdir, "CLAUDE.md");
    tpath = join(pdir, "transcript.jsonl");
    await writeFile(psource, "Capture decisions at the end of a session.\n");
    await writeFile(
      pconfig,
      `protocols:\n  - source: ${psource}\n    title: Session-end capture\n`,
    );
  });

  afterEach(async () => {
    await rm(pdir, { recursive: true, force: true });
  });

  it("hands the running session the protocols when they changed after it started", async () => {
    const startedAt = await syncAndStart(); // the copy the session reads at start
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync(); // the operator publishes an update mid-session

    const context = nudgeContext(await runGate(await transcript(startedAt)));
    expect(context).toContain("Capture decisions AND the next step.");
    expect(context).toContain("## Session-end capture");
    expect(context).toContain("COMPLETE current set");
  });

  it("delivers the complete set, so a withdrawn protocol is announced by its absence", async () => {
    const second = join(pdir, "review.md");
    await writeFile(second, "Review before shipping.\n");
    await writeFile(
      pconfig,
      `protocols:\n  - source: ${psource}\n    title: Session-end capture\n  - source: ${second}\n    title: Review\n`,
    );
    const startedAt = await syncAndStart();

    await writeFile(
      pconfig,
      `protocols:\n  - source: ${psource}\n    title: Session-end capture\n`,
    );
    await sync();

    const context = nudgeContext(await runGate(await transcript(startedAt)));
    expect(context).toContain("## Session-end capture");
    expect(context).not.toContain("Review before shipping.");
    expect(context).toContain("withdrawn");
  });

  it("stays silent when the protocols have not changed since the session started", async () => {
    const startedAt = await syncAndStart();
    expect(await runGate(await transcript(startedAt))).toBe("");
  });

  it("stays silent for an edit the operator has not synced", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "An unpublished draft.\n"); // edited, never synced
    expect(await runGate(await transcript(startedAt))).toBe("");
  });

  it("cannot leak an unsynced draft even when a later sync does publish something else", async () => {
    const second = join(pdir, "review.md");
    await writeFile(second, "Review before shipping.\n");
    const startedAt = await syncAndStart();

    await writeFile(psource, "An unpublished draft.\n"); // never synced
    await writeFile(
      pconfig,
      `protocols:\n  - source: ${psource}\n    title: Session-end capture\n  - source: ${second}\n    title: Review\n`,
    );
    // This sync publishes the draft along with the new protocol, which is what
    // `protocol sync` MEANS -- the block is the published state either way.
    await sync();

    const context = nudgeContext(await runGate(await transcript(startedAt)));
    expect(context).toContain("Review before shipping.");
    expect(context).toContain("An unpublished draft.");
  });

  it("stays silent for an edit that changes no rendered text", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "Capture decisions at the end of a session.\n\n\n");
    await sync();
    expect(await runGate(await transcript(startedAt))).toBe("");
  });

  it("does not repeat itself: its own earlier delivery in the transcript silences it", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync();

    const first = await runGate(await transcript(startedAt));
    expect(nudgeContext(first)).toContain("Capture decisions AND the next step.");

    // The tool records a hook's output in the transcript, so the next turn
    // finds the earlier delivery and does not send it again. The gate scans the
    // real file, so this asserts the scan, not the record shape.
    const body = await transcript(startedAt, [
      JSON.stringify({ type: "attachment", attachment: { hookEvent: "Stop", stdout: first } }),
    ]);
    expect(await runGate(body)).toBe("");
  });

  it("delivers a SECOND update in the same session, because the token carries the block state", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync();
    const first = await runGate(await transcript(startedAt));

    // The operator watches the agent misapply it and tightens the wording.
    await writeFile(psource, "Capture decisions AND the next step, in that order.\n");
    await sync();
    const body = await transcript(startedAt, [
      JSON.stringify({ type: "attachment", attachment: { hookEvent: "Stop", stdout: first } }),
    ]);
    expect(nudgeContext(await runGate(body))).toContain("in that order.");
  });

  it("dates the session from the HEAD of a long transcript, not its tail", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync();

    // Pad past the tail bound the other gates read, so a tail-derived start
    // would be later than the sync and the delivery would be lost.
    const filler = JSON.stringify({
      type: "user",
      timestamp: new Date().toISOString(),
      pad: "x".repeat(4096),
    });
    const lines = [JSON.stringify({ type: "user", timestamp: startedAt })];
    for (let i = 0; i < 3000; i++) lines.push(filler);
    await writeFile(tpath, `${lines.join("\n")}\n`);

    expect(nudgeContext(await runGate(""))).toContain("Capture decisions AND the next step.");
  });

  it("upgrading is silent: the first sync over an older stamp-less block announces nothing", async () => {
    // Every existing installation takes this path once. The block an older
    // basou wrote holds the same protocol text, so no running session is owed
    // anything -- and dating the new stamp at `now` would tell every session on
    // the machine that its protocols changed.
    const sections = "## Session-end capture\n\nCapture decisions at the end of a session.";
    await writeFile(
      ptarget,
      `${PROTOCOL_START}\n<!-- old managed note -->\n\n${sections}\n${PROTOCOL_END}\n`,
    );
    const startedAt = new Date().toISOString();
    await sync();
    expect(await runGate(await transcript(startedAt))).toBe("");
  });

  it("upgrading still delivers when the older block's text really is out of date", async () => {
    await writeFile(
      ptarget,
      `${PROTOCOL_START}\n<!-- old managed note -->\n\n## Session-end capture\n\nSomething else entirely.\n${PROTOCOL_END}\n`,
    );
    const startedAt = new Date().toISOString();
    await sync();
    expect(nudgeContext(await runGate(await transcript(startedAt)))).toContain(
      "Capture decisions at the end of a session.",
    );
  });

  it("stays silent when the block carries no stamp (rendered by an older basou)", async () => {
    await writeFile(
      ptarget,
      `${PROTOCOL_START}\n<!-- old note -->\n\n## Session-end capture\n\nold text\n${PROTOCOL_END}\n`,
    );
    expect(await runGate(await transcript(new Date().toISOString()))).toBe("");
  });

  it("stays silent when there is no protocol block at all", async () => {
    await writeFile(ptarget, "# just the operator's own CLAUDE.md\n");
    expect(await runGate(await transcript(new Date().toISOString()))).toBe("");
  });

  it("stays silent when the transcript never dates the session start", async () => {
    await sync();
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync();
    await writeFile(tpath, `${JSON.stringify({ type: "user" })}\n`);
    expect(await runGate("")).toBe("");
  });

  it("leads the envelope, ahead of the capture nudge it sets the rules for", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync();

    const body = await transcript(startedAt, [editLine(2)]);
    const context = nudgeContext(await runGate(body));
    expect(context.indexOf("SUPERSEDES")).toBeLessThan(context.indexOf("basou decision capture"));
  });

  it("fires on its own, without any capture or review nudge to ride along with", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync();

    const body = await transcript(startedAt, [bashLine(3)]);
    const context = nudgeContext(await runGate(body));
    expect(context).toContain("Capture decisions AND the next step.");
    expect(context).not.toContain("basou decision capture");
  });

  it("honours the loop guard: a continuation turn delivers nothing", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync();

    const body = await transcript(startedAt);
    const out = await run(
      { transcript_path: tpath, stop_hook_active: true },
      body,
      {},
      {
        protocolTargetPath: ptarget,
      },
    );
    expect(out).toBe("");
  });

  it("blocks with the protocol text when the operator opted into enforcement", async () => {
    const startedAt = await syncAndStart();
    await writeFile(psource, "Capture decisions AND the next step.\n");
    await sync();

    const parsed = JSON.parse(await runGate(await transcript(startedAt), { block: true })) as {
      decision: string;
      reason: string;
    };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("Capture decisions AND the next step.");
  });

  it("lets the capture nudge through when the target is unreadable", async () => {
    await rm(ptarget, { force: true });
    const body = await transcript(new Date().toISOString(), [editLine(2)]);
    expect(nudgeContext(await runGate(body))).toContain("basou decision capture");
  });
});
