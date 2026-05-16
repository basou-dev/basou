import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { atomicCreate, atomicReplace } from "./atomic.js";

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
 * Write a value as YAML using {@link atomicReplace} for crash-resistant
 * atomicity. The shared helper handles the tmp-file + rename sequence,
 * `wx` collision guard, and best-effort tmp cleanup on failure. This
 * wrapper adds the YAML serialisation and the pathless error vocabulary.
 */
export async function writeYamlFile(filePath: string, value: unknown): Promise<void> {
  const body = stringify(value);
  try {
    await atomicReplace(filePath, body);
  } catch (error: unknown) {
    throw new Error("Failed to write YAML file", { cause: error });
  }
}

/**
 * Atomically create a new YAML file. Like {@link writeYamlFile} but
 * delegates to {@link atomicCreate} so a pre-existing target fails with
 * EEXIST instead of being silently overwritten.
 *
 * Used by `basou approval approve` / `reject` to write the resolved-side
 * YAML, so a concurrent resolver cannot overwrite an already-resolved
 * approval.
 *
 * Throws `Error("Failed to write YAML file", { cause })` on failure; if
 * `cause.code === "EEXIST"` the caller can detect a target-exists race.
 */
export async function linkYamlFile(filePath: string, value: unknown): Promise<void> {
  const body = stringify(value);
  try {
    await atomicCreate(filePath, body);
  } catch (error: unknown) {
    throw new Error("Failed to write YAML file", { cause: error });
  }
}

/**
 * Overwrite an existing YAML file atomically. Like {@link writeYamlFile}
 * but with a distinct pathless message label, used for files that
 * legitimately need in-place mutation (e.g. session.yaml's status /
 * ended_at lifecycle updates).
 */
export async function overwriteYamlFile(filePath: string, value: unknown): Promise<void> {
  const body = stringify(value);
  try {
    await atomicReplace(filePath, body);
  } catch (error: unknown) {
    throw new Error("Failed to overwrite YAML file", { cause: error });
  }
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  return typeof (error as unknown as Record<string, unknown>).code === "string";
}
