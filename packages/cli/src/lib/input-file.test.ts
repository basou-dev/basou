import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type InputFileAlternative,
  type InputFileFlag,
  readInputFileText,
  refuseDashInputFile,
} from "./input-file.js";

describe("refuseDashInputFile", () => {
  it("refuses exactly - and says to omit the flag when the command reads stdin", () => {
    expect(() => refuseDashInputFile("--file", "-", "stdin")).toThrow(
      new Error(
        "--file - is refused: - is reserved for standard input. " +
          "Omit --file to read stdin, or pass --file ./- to read a file named -.",
      ),
    );
  });

  it("refuses exactly - and offers a file, then the inline flag, when the command does not read stdin", () => {
    expect(() => refuseDashInputFile("--from-file", "-", { textFlag: "--description" })).toThrow(
      new Error(
        "--from-file - is refused: - is reserved for standard input, which this command does not read. " +
          "Write the text to a file and pass --from-file <path>, or pass it with --description; " +
          "a file named - is read with --from-file ./-.",
      ),
    );
  });

  it("refuses exactly - and offers only a file when the command reads its input from a file alone", () => {
    expect(() => refuseDashInputFile("--from", "-", { fileOnly: "the JSON" })).toThrow(
      new Error(
        "--from - is refused: - is reserved for standard input, which this command does not read. " +
          "Write the JSON to a file and pass its path with --from; a file named - is read with --from ./-.",
      ),
    );
  });

  it("leaves every other value, and an omitted flag, to the command", () => {
    const cases: Array<[InputFileFlag, InputFileAlternative]> = [
      ["--file", "stdin"],
      ["--from-file", { textFlag: "--body" }],
      ["--from", { fileOnly: "the JSON" }],
    ];
    for (const value of [undefined, "", "./-", "/abs/-", "-.json", "--", " -", "- ", "dir/-"]) {
      for (const [flag, alternative] of cases) {
        expect(() => refuseDashInputFile(flag, value, alternative), String(value)).not.toThrow();
      }
    }
  });
});

describe("readInputFileText", () => {
  it("reads the file, and refuses one it cannot read with a message that names the flag, not the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basou-input-file-"));
    try {
      await writeFile(join(dir, "in.json"), "[1]\n");
      await mkdir(join(dir, "a-directory"));
      await writeFile(join(dir, "locked.json"), "[]");
      await chmod(join(dir, "locked.json"), 0o000);
      expect(await readInputFileText("--file", join(dir, "in.json"))).toBe("[1]\n");
      const cases: Array<[InputFileFlag, string, string, string]> = [
        ["--file", "missing.json", "--file names a file that does not exist", "ENOENT"],
        ["--from", "a-directory", "--from names a directory, not a file", "EISDIR"],
      ];
      // Root reads a 0o000 file anyway.
      if (process.getuid?.() !== 0) {
        cases.push([
          "--from-file",
          "locked.json",
          "Could not read the file --from-file names",
          "EACCES",
        ]);
      }
      for (const [flag, name, message, code] of cases) {
        const error = await readInputFileText(flag, join(dir, name)).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error, name).toBeInstanceOf(Error);
        expect((error as Error).message, name).toBe(message);
        expect((error as Error).message, name).not.toContain(dir);
        // An Error, so that --verbose can print its code (renderCliError reads
        // the code only off an Error).
        expect((error as Error).cause, name).toBeInstanceOf(Error);
        expect(((error as Error).cause as NodeJS.ErrnoException).code, name).toBe(code);
      }
    } finally {
      await chmod(join(dir, "locked.json"), 0o600).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
