/**
 * The flags that name a file to read a command's input from: `--file`
 * (`basou decision capture`, `basou review record`, `basou note`) and
 * `--from-file` (`basou task new`, `basou session note`).
 */
export type InputFileFlag = "--file" | "--from-file";

/**
 * Refuse `-` as the value of an input-file flag. `-` is reserved for standard
 * input, which none of these flags reads today. Refusing it keeps that open:
 * reading stdin for a `-` that was refused only adds, while switching a `-`
 * that named a file to stdin would change what the flag means. A file really
 * named `-` stays reachable as `./-`, which the message says.
 *
 * Call it before any disk I/O, so the refusal never depends on what is on disk.
 * `stdinWhenOmitted` is true for a command that reads stdin when the flag is
 * left out; the message then says so.
 */
export function refuseDashInputFile(
  flag: InputFileFlag,
  value: string | undefined,
  stdinWhenOmitted: boolean,
): void {
  if (value !== "-") return;
  const hint = stdinWhenOmitted
    ? `Omit ${flag} to read stdin, or pass ${flag} ./- to read a file named -.`
    : `Pass ${flag} ./- to read a file named -.`;
  throw new Error(`${flag} - is reserved for standard input and is refused. ${hint}`);
}
