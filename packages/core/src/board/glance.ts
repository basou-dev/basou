import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeTime } from "ulid";
import { parse } from "yaml";
import { findErrorCode } from "../lib/error-codes.js";
import { recordIds } from "./previous.js";

/**
 * What a workspace's position says of its board, read loosely: the board is
 * not checked, only looked at, so a broken one never fails the position.
 */
export type BoardGlance = {
  /**
   * When the last record was written, read from its ULID: null when there
   * is none, undefined when the records cannot be read.
   */
  lastRecordAt: string | null | undefined;
  /** The declaration's `axis.version`, null when it cannot be read. */
  axisVersion: number | null;
};

/**
 * Glance at the board declared at `boardYaml`: the names of the records
 * beside it and the axis version it declares, nothing else. Null when there
 * is no board there. Never throws.
 */
export async function glanceBoard(boardYaml: string): Promise<BoardGlance | null> {
  try {
    if (!(await stat(boardYaml)).isFile()) return null;
  } catch {
    return null;
  }
  let axisVersion: number | null = null;
  try {
    const raw: unknown = parse(await readFile(boardYaml, "utf8"), {
      version: "1.2",
      logLevel: "silent",
      maxAliasCount: 100,
    });
    const version = (raw as { axis?: { version?: unknown } } | null)?.axis?.version;
    if (typeof version === "number" && Number.isInteger(version) && version >= 1) {
      axisVersion = version;
    }
  } catch {
    axisVersion = null;
  }
  let lastRecordAt: string | null | undefined;
  try {
    const records = join(dirname(boardYaml), "records");
    // A link or a file is not read, as the board page does not read one.
    if (!(await lstat(records)).isDirectory()) throw new Error("not a directory");
    const ids = recordIds(await readdir(records));
    const last = ids.at(-1);
    lastRecordAt = last === undefined ? null : new Date(decodeTime(last)).toISOString();
  } catch (error: unknown) {
    lastRecordAt = findErrorCode(error, "ENOENT") ? null : undefined;
  }
  return { lastRecordAt, axisVersion };
}
