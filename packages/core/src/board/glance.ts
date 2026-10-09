import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeTime } from "ulid";
import { parseDocument } from "yaml";
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
 * The largest board.yaml glanced at for its axis version. A position is
 * rendered at every session start, under a time limit, and reading YAML
 * grows faster than the file; a board of this size is far larger than any
 * written by hand.
 */
export const BOARD_GLANCE_MAX_BYTES = 128 * 1024;

/**
 * Glance at the board declared at `boardYaml`: the names of the records
 * beside it and the axis version it declares, nothing else. Null when there
 * is no board there. Never throws.
 */
export async function glanceBoard(boardYaml: string): Promise<BoardGlance | null> {
  let size: number;
  try {
    const entry = await stat(boardYaml);
    if (!entry.isFile()) return null;
    size = entry.size;
  } catch {
    return null;
  }
  let axisVersion: number | null = null;
  try {
    if (size <= BOARD_GLANCE_MAX_BYTES)
      axisVersion = axisVersionOf(await readFile(boardYaml, "utf8"));
  } catch {
    axisVersion = null;
  }
  let lastRecordAt: string | null | undefined;
  try {
    const records = join(dirname(boardYaml), "records");
    // A link or a file is not read, as the board page does not read one.
    if (!(await lstat(records)).isDirectory()) throw new Error("not a directory");
    // A directory that bears a record's name is not a record.
    const files = (await readdir(records, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const ids = recordIds(files);
    const last = ids.at(-1);
    lastRecordAt = last === undefined ? null : new Date(decodeTime(last)).toISOString();
  } catch (error: unknown) {
    lastRecordAt = findErrorCode(error, "ENOENT") ? null : undefined;
  }
  return { lastRecordAt, axisVersion };
}

// The axis version a board.yaml declares, read as basou board reads YAML (1.2
// only, no key twice, nothing the parser could only guess at), or null.
function axisVersionOf(text: string): number | null {
  const doc = parseDocument(text, { version: "1.2", uniqueKeys: true, logLevel: "silent" });
  if (doc.errors.length > 0 || doc.warnings.length > 0) return null;
  if (doc.directives?.yaml.version !== "1.2") return null;
  const raw: unknown = doc.toJS({ maxAliasCount: 100 });
  const version = (raw as { axis?: { version?: unknown } } | null)?.axis?.version;
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : null;
}
