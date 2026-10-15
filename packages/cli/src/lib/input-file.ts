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
 * - `{ textFlag }` — it does not read stdin; the text can be passed inline with
 *   `textFlag`.
 * - `"file-only"` — it does not read stdin and takes the input only from the
 *   file.
 */
export type InputFileAlternative = "stdin" | { textFlag: string } | "file-only";

/**
 * Refuse `-` as the value of an input-file flag. `-` is reserved for standard
 * input, which none of these flags reads today. Refusing it keeps that open:
 * reading stdin for a `-` that was refused only adds, while switching a `-`
 * that named a file to stdin would change what the flag means. A file really
 * named `-` stays reachable as `./-`, which the message says.
 *
 * Call it before any disk I/O, so the refusal never depends on what is on disk.
 * The message names the command's other way in (see
 * {@link InputFileAlternative}), so that a command that does not read stdin
 * does not read as one that does.
 */
export function refuseDashInputFile(
  flag: InputFileFlag,
  value: string | undefined,
  alternative: InputFileAlternative,
): void {
  if (value !== "-") return;
  const toFile = `pass ${flag} ./- to read a file named -`;
  const hint =
    alternative === "stdin"
      ? `Omit ${flag} to read stdin, or ${toFile}.`
      : alternative === "file-only"
        ? `This command does not read stdin: ${toFile}.`
        : `This command does not read stdin: pass the text with ${alternative.textFlag}, or ${toFile}.`;
  throw new Error(`${flag} - is reserved for standard input and is refused. ${hint}`);
}
