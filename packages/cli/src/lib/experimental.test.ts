import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../program.js";
import {
  EXPERIMENTAL_COMMANDS,
  EXPERIMENTAL_MARK,
  markExperimentalCommands,
} from "./experimental.js";

const TABLE_HEADER = "| Command | Experimental since |";
const TABLE_DELIMITER = "|---|---|";
const EMPTY_SENTENCE = "No command is experimental yet.";

// The top-level commands that existed when the list was introduced. An
// existing command is never moved onto the list, so none of these may ever
// join it. Frozen on purpose: a command added later is not appended here.
const COMMANDS_BEFORE_THE_LIST = [
  "approval",
  "channel",
  "decision",
  "decisions",
  "exec",
  "handoff",
  "hook",
  "import",
  "init",
  "note",
  "orient",
  "portfolio",
  "project",
  "protocol",
  "refresh",
  "report",
  "review",
  "review-gaps",
  "run",
  "session",
  "stats",
  "status",
  "task",
  "verify",
  "view",
];

async function notGuaranteedSection(): Promise<string> {
  const doc = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/spec/compatibility.md"),
    "utf8",
  );
  const start = doc.indexOf("\n## What is *not* guaranteed\n");
  if (start === -1) throw new Error("section not found: What is *not* guaranteed");
  const end = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

// The rows of the table. It sits inside a list item, so its lines are
// indented.
function tableRows(section: string): { command: string; since: string }[] {
  const lines = section.split("\n").map((line) => line.trim());
  const start = lines.indexOf(TABLE_HEADER);
  if (start === -1) throw new Error(`table not found: ${TABLE_HEADER}`);
  if (lines[start + 1] !== TABLE_DELIMITER) {
    throw new Error(`table without its delimiter row: ${lines[start + 1]}`);
  }
  const rows: { command: string; since: string }[] = [];
  for (const row of lines.slice(start + 2)) {
    if (!row.startsWith("|")) break;
    const cells = /^\| `basou ([a-z][a-z-]*)` \| ([^|]*) \|$/.exec(row);
    if (cells === null) throw new Error(`row that does not name one top-level command: ${row}`);
    rows.push({ command: cells[1] as string, since: (cells[2] as string).trim() });
  }
  return rows;
}

// Every command in the tree under `program`, with the top-level command it
// belongs to and the text its parent's help lists it by.
function walk(program: Command): {
  path: string;
  top: string;
  description: string;
  summary: string;
  listedAs: string;
}[] {
  const out: ReturnType<typeof walk> = [];
  const visit = (command: Command, parent: Command, top: string, path: string): void => {
    out.push({
      path,
      top,
      description: command.description(),
      summary: command.summary(),
      listedAs: parent.createHelp().subcommandDescription(command),
    });
    for (const sub of command.commands) visit(sub, command, top, `${path} ${sub.name()}`);
  };
  for (const command of program.commands) {
    visit(command, program, command.name(), command.name());
  }
  return out;
}

// Each command whose help text breaks the rule: under a listed top-level
// command, the description, the summary when there is one, and the text the
// parent's help lists it by each start with the mark and carry it once;
// anywhere else, none of them carries it at all.
function markProblems(program: Command, names: readonly string[]): string[] {
  const once = (text: string): boolean =>
    text.startsWith(`${EXPERIMENTAL_MARK} `) && text.split(EXPERIMENTAL_MARK).length === 2;
  return walk(program).flatMap(({ path, top, description, summary, listedAs }) => {
    const texts = summary === "" ? [description, listedAs] : [description, summary, listedAs];
    if (names.includes(top)) return texts.every(once) ? [] : [`${path}: mark missing or repeated`];
    return texts.some((text) => text.includes(EXPERIMENTAL_MARK))
      ? [`${path}: mark on a guaranteed command`]
      : [];
  });
}

describe("experimental commands as documented", () => {
  it("lists the same commands in compatibility.md's table as in EXPERIMENTAL_COMMANDS", async () => {
    const section = await notGuaranteedSection();
    const rows = tableRows(section);
    expect(rows.map((row) => row.command).sort()).toEqual([...EXPERIMENTAL_COMMANDS].sort());
    // A command joins in the release that introduces it, which is a minor.
    expect(rows.filter((row) => !/^\d+\.\d+\.0$/.test(row.since))).toEqual([]);
    // The sentence saying the table is empty goes when the first row comes.
    // It may wrap, so compare with the whitespace collapsed.
    const prose = section.replace(/\s+/g, " ");
    expect(prose.includes(EMPTY_SENTENCE)).toBe(EXPERIMENTAL_COMMANDS.length === 0);
  });

  it("never lists a command that existed before the list", () => {
    expect(EXPERIMENTAL_COMMANDS.filter((name) => COMMANDS_BEFORE_THE_LIST.includes(name))).toEqual(
      [],
    );
  });

  it("marks in --help exactly the listed commands and every command under them", () => {
    const program = buildProgram();
    const registered = program.commands.map((c) => c.name());
    expect(EXPERIMENTAL_COMMANDS.filter((name) => !registered.includes(name))).toEqual([]);
    expect(markProblems(program, EXPERIMENTAL_COMMANDS)).toEqual([]);
  });
});

describe("markExperimentalCommands", () => {
  function sample(): Command {
    const program = new Command("basou");
    const alpha = program.command("alpha").description("Alpha does a thing").summary("Alpha");
    alpha.command("beta").description("Beta does a thing").command("gamma").description("Gamma");
    program.command("alpha-two").description("Alpha-two does a thing");
    program.command("delta").description("Delta does a thing");
    return program;
  }

  it("prefixes the listed command and its whole subtree, and nothing else", () => {
    const program = sample();
    markExperimentalCommands(program, ["alpha"]);
    expect(
      walk(program).map(({ path, description, summary }) => [path, description, summary]),
    ).toEqual([
      ["alpha", "[experimental] Alpha does a thing", "[experimental] Alpha"],
      ["alpha beta", "[experimental] Beta does a thing", ""],
      ["alpha beta gamma", "[experimental] Gamma", ""],
      ["alpha-two", "Alpha-two does a thing", ""],
      ["delta", "Delta does a thing", ""],
    ]);
    expect(markProblems(program, ["alpha"])).toEqual([]);
  });

  it("shows the mark in the parent's command list and in the command's own help", () => {
    const program = sample();
    markExperimentalCommands(program, ["alpha"]);
    const help = program.helpInformation();
    expect(help).toMatch(/alpha\s+\[experimental\] Alpha\n/);
    expect(help).toMatch(/alpha-two\s+Alpha-two does a thing\n/);
    const beta = program.commands[0]?.commands[0];
    expect(beta?.helpInformation()).toContain("[experimental] Beta does a thing");
  });

  it("marks nothing when the list is empty", () => {
    const program = sample();
    markExperimentalCommands(program, []);
    expect(markProblems(program, [])).toEqual([]);
  });

  it("is checked by a rule that sees a hand-typed, repeated or missing mark", () => {
    const handTyped = sample();
    handTyped.commands[2]?.summary(`Delta ${EXPERIMENTAL_MARK}`);
    expect(markProblems(handTyped, [])).toEqual(["delta: mark on a guaranteed command"]);

    const repeated = sample();
    markExperimentalCommands(repeated, ["alpha"]);
    markExperimentalCommands(repeated, ["alpha"]);
    expect(markProblems(repeated, ["alpha"])).toContain("alpha: mark missing or repeated");

    const missing = sample();
    expect(markProblems(missing, ["alpha"])).toContain("alpha beta: mark missing or repeated");
  });
});
