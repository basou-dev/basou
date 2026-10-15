import { describe, expect, it } from "vitest";
import { refuseDashInputFile } from "./input-file.js";

describe("refuseDashInputFile", () => {
  it("refuses exactly - and says how to read stdin when the command reads it", () => {
    expect(() => refuseDashInputFile("--file", "-", true)).toThrow(
      new Error(
        "--file - is reserved for standard input and is refused. " +
          "Omit --file to read stdin, or pass --file ./- to read a file named -.",
      ),
    );
  });

  it("refuses exactly - and offers only ./- when the command does not read stdin", () => {
    expect(() => refuseDashInputFile("--from-file", "-", false)).toThrow(
      new Error(
        "--from-file - is reserved for standard input and is refused. " +
          "Pass --from-file ./- to read a file named -.",
      ),
    );
  });

  it("leaves every other value, and an omitted flag, to the command", () => {
    for (const value of [undefined, "", "./-", "/abs/-", "-.json", "--", " -", "- ", "dir/-"]) {
      expect(() => refuseDashInputFile("--file", value, true), String(value)).not.toThrow();
      expect(() => refuseDashInputFile("--from-file", value, false), String(value)).not.toThrow();
    }
  });
});
