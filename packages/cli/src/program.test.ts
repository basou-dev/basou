import { afterEach, describe, expect, it, vi } from "vitest";

describe("buildProgram", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("never parses argv or exits at import time", async () => {
    // Positively guard the import-safety invariant the docs generator relies
    // on: importing the module must not consume process.argv or exit. Reset
    // the module registry, then import commander and spy its prototype BEFORE
    // importing program.js so the latter binds to the spied class — a stray
    // top-level parse/exit in program.ts (or a command module it pulls in) is
    // then caught here instead of silently tolerated. `index.ts` owns the
    // single parseAsync, so this module must trigger none.
    vi.resetModules();
    const { Command } = await import("commander");
    const parseAsyncSpy = vi.spyOn(Command.prototype, "parseAsync");
    const parseSpy = vi.spyOn(Command.prototype, "parse");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await import("./program.js");

    expect(parseAsyncSpy).not.toHaveBeenCalled();
    expect(parseSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("registers the full command tree (the externally visible CLI surface)", async () => {
    // A dropped/added registerXxxCommand call (e.g. after a refactor) trips
    // this exact-set assertion.
    const { buildProgram } = await import("./program.js");
    const program = buildProgram();
    expect(program.name()).toBe("basou");
    expect(program.commands.map((c) => c.name()).sort()).toEqual([
      "approval",
      "decision",
      "decisions",
      "exec",
      "handoff",
      "import",
      "init",
      "orient",
      "project",
      "refresh",
      "report",
      "review-gaps",
      "run",
      "session",
      "stats",
      "status",
      "task",
      "verify",
      "view",
    ]);
  });

  it("registers the project subcommands (adopt + check + gitignore + preset + symlinks + sync + wiring + workspace)", async () => {
    const { buildProgram } = await import("./program.js");
    const program = buildProgram();
    const project = program.commands.find((c) => c.name() === "project");
    expect(project?.commands.map((c) => c.name()).sort()).toEqual([
      "adopt",
      "check",
      "gitignore",
      "preset",
      "symlinks",
      "sync",
      "wiring",
      "workspace",
    ]);
  });

  it("exposes the package version constant", async () => {
    const { BASOU_CLI_VERSION } = await import("./program.js");
    expect(BASOU_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
