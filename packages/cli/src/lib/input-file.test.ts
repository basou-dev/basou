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
