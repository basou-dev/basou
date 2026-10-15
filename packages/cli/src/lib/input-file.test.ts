import { describe, expect, it } from "vitest";
import {
  type InputFileAlternative,
  type InputFileFlag,
  refuseDashInputFile,
} from "./input-file.js";

describe("refuseDashInputFile", () => {
  it("refuses exactly - and says to omit the flag when the command reads stdin", () => {
    expect(() => refuseDashInputFile("--file", "-", "stdin")).toThrow(
      new Error(
        "--file - is reserved for standard input and is refused. " +
          "Omit --file to read stdin, or pass --file ./- to read a file named -.",
      ),
    );
  });

  it("refuses exactly - and names the inline flag when the command does not read stdin", () => {
    expect(() => refuseDashInputFile("--from-file", "-", { textFlag: "--description" })).toThrow(
      new Error(
        "--from-file - is reserved for standard input and is refused. " +
          "This command does not read stdin: pass the text with --description, " +
          "or pass --from-file ./- to read a file named -.",
      ),
    );
  });

  it("refuses exactly - and offers only ./- when the command reads the file alone", () => {
    expect(() => refuseDashInputFile("--from", "-", "file-only")).toThrow(
      new Error(
        "--from - is reserved for standard input and is refused. " +
          "This command does not read stdin: pass --from ./- to read a file named -.",
      ),
    );
  });

  it("leaves every other value, and an omitted flag, to the command", () => {
    const cases: Array<[InputFileFlag, InputFileAlternative]> = [
      ["--file", "stdin"],
      ["--from-file", { textFlag: "--body" }],
      ["--from", "file-only"],
    ];
    for (const value of [undefined, "", "./-", "/abs/-", "-.json", "--", " -", "- ", "dir/-"]) {
      for (const [flag, alternative] of cases) {
        expect(() => refuseDashInputFile(flag, value, alternative), String(value)).not.toThrow();
      }
    }
  });
});
