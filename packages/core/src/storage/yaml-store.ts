import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";

/**
 * Read a YAML file as `unknown`. Caller MUST validate via a zod schema.
 *
 * Throws Error with pathless message and the original native error attached
 * as `cause` for I/O failures and YAML parse errors. All fs and parse exits
 * go through fixed messages so absolute paths cannot leak via `error.message`.
 */
export async function readYamlFile(filePath: string): Promise<unknown> {
  let body: string;
  try {
    body = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === "ENOENT") {
      throw new Error("YAML file not found", { cause: error });
    }
    throw new Error("Failed to read YAML file", { cause: error });
  }
  try {
    return parse(body);
  } catch (error: unknown) {
    throw new Error("Failed to parse YAML content", { cause: error });
  }
}

/**
 * Write a value as YAML using a tmp-file + rename for crash-resistant
 * atomicity.
 *
 * The tmp file path is `${filePath}.tmp.${randomUUID()}` — placed in the
 * SAME directory as the target so that `rename` stays within one
 * filesystem and cannot fail with EXDEV. The tmp file is opened with the
 * `wx` flag, so a hypothetical name collision fails fast rather than
 * silently overwriting an unrelated file. On any failure the tmp file is
 * unlinked best-effort and the original error is re-thrown with a pathless
 * message.
 */
export async function writeYamlFile(filePath: string, value: unknown): Promise<void> {
  const body = stringify(value);
  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmpPath, body, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, filePath);
  } catch (error: unknown) {
    await unlink(tmpPath).catch(() => undefined);
    throw new Error("Failed to write YAML file", { cause: error });
  }
}

/**
 * Overwrite an existing YAML file atomically. Like {@link writeYamlFile}
 * but without the `wx` collision check on the temp file's target — used
 * for files that legitimately need in-place mutation (e.g. session.yaml's
 * status / ended_at lifecycle updates).
 *
 * Uses tmp-file + rename within the same directory for crash-resistant
 * atomicity. Error messages are pathless; the native cause is attached.
 */
export async function overwriteYamlFile(filePath: string, value: unknown): Promise<void> {
  const body = stringify(value);
  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmpPath, body, { encoding: "utf8" });
    await rename(tmpPath, filePath);
  } catch (error: unknown) {
    await unlink(tmpPath).catch(() => undefined);
    throw new Error("Failed to overwrite YAML file", { cause: error });
  }
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  return typeof (error as unknown as Record<string, unknown>).code === "string";
}
