import { readFile } from "node:fs/promises";
import { findErrorCode } from "@basou/core";

/**
 * The flags that name a file to read a command's input from: `--file`
 * (`basou decision capture`, `basou review record`, `basou note`),
 * `--from-file` (`basou task new`, `basou session note`) and `--from`
 * (`basou session import`).
 */
export type InputFileFlag = "--file" | "--from-file" | "--from";

/**
 * Where a command takes its input when not from the file:
 *
 * - `"stdin"` — it reads stdin when the flag is left out.
 * - `{ textFlag }` — it does not read stdin; the text can also be passed
 *   inline with `textFlag`.
 * - `{ fileOnly }` — it does not read stdin and takes the input only from a
 *   file; `fileOnly` names the input (`"the JSON"`).
 */
export type InputFileAlternative = "stdin" | { textFlag: string } | { fileOnly: string };

/**
 * Refuse `-` as the value of an input-file flag. `-` is reserved for standard
 * input, which none of these flags reads today. Refusing it keeps that open:
 * reading stdin for a `-` that was refused only adds, while switching a `-`
 * that named a file to stdin would change what the flag means. A file really
 * named `-` stays reachable as `./-`, which the message says.
 *
 * Call it before any disk I/O, so the refusal never depends on what is on disk.
 * The message names the command's other ways in (see
 * {@link InputFileAlternative}). For a command that does not read stdin it
 * says so, and offers a file before the inline flag: text meant for stdin is
 * safer in a file than in a shell word, where double quotes still run
 * backticks and `$(...)`.
 */
export function refuseDashInputFile(
  flag: InputFileFlag,
  value: string | undefined,
  alternative: InputFileAlternative,
): void {
  if (value !== "-") return;
  if (alternative === "stdin") {
    throw new Error(
      `${flag} - is refused: - is reserved for standard input. ` +
        `Omit ${flag} to read stdin, or pass ${flag} ./- to read a file named -.`,
    );
  }
  const toFile =
    "textFlag" in alternative
      ? `Write the text to a file and pass ${flag} <path>, or pass it with ${alternative.textFlag}`
      : `Write ${alternative.fileOnly} to a file and pass its path with ${flag}`;
  throw new Error(
    `${flag} - is refused: - is reserved for standard input, which this command does not read. ` +
      `${toFile}; a file named - is read with ${flag} ./-.`,
  );
}

/**
 * Read the text of the file an input-file flag names. A failure is a fixed
 * message that names the flag and never the path, per the CLI's pathless error
 * contract (a path the caller gave can be absolute); the cause, shown with
 * `--verbose` as its code, has the detail.
 */
export async function readInputFileText(flag: InputFileFlag, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error(`${flag} names a file that does not exist`, { cause: error });
    }
    if (findErrorCode(error, "EISDIR")) {
      throw new Error(`${flag} names a directory, not a file`, { cause: error });
    }
    throw new Error(`Could not read the file ${flag} names`, { cause: error });
  }
}
