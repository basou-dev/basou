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
const EMPTY_SENTENCE = "No command is experimental yet.";

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

// The command named in each row of the table. The table sits inside a list
// item, so its lines are indented.
function tableCommands(section: string): string[] {
  const lines = section.split("\n").map((line) => line.trim());
  const start = lines.indexOf(TABLE_HEADER);
  if (start === -1) throw new Error(`table not found: ${TABLE_HEADER}`);
  const names: string[] = [];
  for (const row of lines.slice(start + 2)) {
    if (!row.startsWith("|")) break;
    const name = /^\| `basou ([a-z][a-z-]*)`/.exec(row);
    if (name === null) throw new Error(`row without a backticked basou command: ${row}`);
    names.push(name[1] as string);
  }
  return names;
}

// Every command in the tree under `program`, with the name of the top-level
// command it belongs to.
function walk(program: Command): { path: string; top: string; description: string }[] {
  const out: { path: string; top: string; description: string }[] = [];
  const visit = (command: Command, top: string, path: string): void => {
    out.push({ path, top, description: command.description() });
    for (const sub of command.commands) visit(sub, top, `${path} ${sub.name()}`);
  };
  for (const command of program.commands) visit(command, command.name(), command.name());
  return out;
}

describe("experimental commands as documented", () => {
  it("lists the same commands in compatibility.md's table as in EXPERIMENTAL_COMMANDS", async () => {
    const section = await notGuaranteedSection();
    expect([...tableCommands(section)].sort()).toEqual([...EXPERIMENTAL_COMMANDS].sort());
    // The sentence saying the table is empty goes when the first row comes.
    // It may wrap, so compare with the whitespace collapsed.
    const prose = section.replace(/\s+/g, " ");
    expect(prose.includes(EMPTY_SENTENCE)).toBe(EXPERIMENTAL_COMMANDS.length === 0);
  });

  it("marks in --help exactly the listed commands and every command under them", () => {
    const program = buildProgram();
    const registered = program.commands.map((c) => c.name());
    expect(EXPERIMENTAL_COMMANDS.filter((name) => !registered.includes(name))).toEqual([]);
    const wrong = walk(program)
      .filter(
        ({ top, description }) =>
          description.startsWith(EXPERIMENTAL_MARK) !== EXPERIMENTAL_COMMANDS.includes(top),
      )
      .map(({ path }) => path);
    expect(wrong).toEqual([]);
  });
});

describe("markExperimentalCommands", () => {
  function sample(): Command {
    const program = new Command("basou");
    const alpha = program.command("alpha").description("Alpha does a thing");
    alpha.command("beta").description("Beta does a thing").command("gamma").description("Gamma");
    program.command("delta").description("Delta does a thing");
    return program;
  }

  it("prefixes the listed command and its whole subtree, and nothing else", () => {
    const program = sample();
    markExperimentalCommands(program, ["alpha"]);
    expect(walk(program).map(({ path, description }) => [path, description])).toEqual([
      ["alpha", "[experimental] Alpha does a thing"],
      ["alpha beta", "[experimental] Beta does a thing"],
      ["alpha beta gamma", "[experimental] Gamma"],
      ["delta", "Delta does a thing"],
    ]);
  });

  it("shows the mark in the parent's command list and in the command's own help", () => {
    const program = sample();
    markExperimentalCommands(program, ["alpha"]);
    expect(program.helpInformation()).toMatch(/alpha.*\[experimental\] Alpha does a thing/);
    expect(program.helpInformation()).not.toMatch(/\[experimental\] Delta/);
    const beta = program.commands[0]?.commands[0];
    expect(beta?.helpInformation()).toContain("[experimental] Beta does a thing");
  });

  it("marks nothing when the list is empty", () => {
    const program = sample();
    markExperimentalCommands(program, []);
    expect(
      walk(program).filter(({ description }) => description.includes(EXPERIMENTAL_MARK)),
    ).toEqual([]);
  });
});
