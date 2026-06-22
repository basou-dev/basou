import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readYamlFile } from "@basou/core";

/**
 * One declared standing protocol: a markdown source file (the protocol text)
 * and an optional display title. `source` is resolved to an absolute path by
 * {@link loadProtocolsConfig}.
 */
export type ProtocolEntry = { source: string; title?: string };

/** Canonical location of the protocols config (a user-level, machine-local file). */
export const DEFAULT_PROTOCOLS_CONFIG_PATH = join(homedir(), ".basou", "protocols.yaml");

/**
 * Locked render target for this slice: the user-global Claude Code instructions
 * file, which Claude Code auto-loads at every session start. The target is not
 * read from the config (a config-supplied path would let the writer append to
 * arbitrary files); only an explicit `--target` flag may override it, and that
 * override exists for tests.
 */
export const DEFAULT_TARGET_PATH = join(homedir(), ".claude", "CLAUDE.md");

const ALLOWED_TOP_KEYS = new Set(["version", "protocols"]);
const ALLOWED_ENTRY_KEYS = new Set(["source", "title"]);

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and validate `~/.basou/protocols.yaml` (or an injected path for tests),
 * returning the protocol entries with each `source` expanded to an absolute
 * path. Throws an Error with a pathless, user-facing message on a missing file,
 * invalid YAML, a malformed shape, an unknown key, an empty or duplicate
 * source, an empty title, or an empty list.
 *
 * Shape (strict; unknown keys are rejected):
 *   version: 1            # optional
 *   protocols:
 *     - source: ~/projects/foo-planning/protocols/bar.md   # required, absolute or ~
 *       title: Bar Protocol                                # optional, non-empty
 */
export async function loadProtocolsConfig(
  configPath: string = DEFAULT_PROTOCOLS_CONFIG_PATH,
): Promise<ProtocolEntry[]> {
  let raw: unknown;
  try {
    raw = await readYamlFile(configPath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") {
      throw new Error(
        "No protocols config at ~/.basou/protocols.yaml. Create one (a 'protocols:' list of source markdown paths) before running 'basou protocol sync'.",
      );
    }
    if (error instanceof Error && error.message === "Failed to parse YAML content") {
      throw new Error("~/.basou/protocols.yaml is not valid YAML.");
    }
    throw error;
  }

  if (!isRecord(raw) || !Array.isArray(raw.protocols)) {
    throw new Error("~/.basou/protocols.yaml must contain a 'protocols:' list.");
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(
        `~/.basou/protocols.yaml has an unknown key '${key}' (allowed: version, protocols).`,
      );
    }
  }

  const seen = new Set<string>();
  const result: ProtocolEntry[] = [];
  for (const entry of raw.protocols) {
    if (!isRecord(entry)) {
      throw new Error("Each protocol entry must be a mapping with a 'source' key.");
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_ENTRY_KEYS.has(key)) {
        throw new Error(`A protocol entry has an unknown key '${key}' (allowed: source, title).`);
      }
    }
    if (typeof entry.source !== "string" || entry.source.trim().length === 0) {
      throw new Error("Each protocol entry needs a non-empty string 'source'.");
    }
    if (
      entry.title !== undefined &&
      (typeof entry.title !== "string" || entry.title.trim().length === 0)
    ) {
      throw new Error("A protocol entry 'title' must be a non-empty string when present.");
    }
    const expanded = expandTilde(entry.source.trim());
    if (!isAbsolute(expanded)) {
      throw new Error("Protocol 'source' paths must be absolute (or start with '~').");
    }
    const abs = resolve(expanded);
    if (seen.has(abs)) {
      throw new Error("Duplicate protocol source (each source path may appear only once).");
    }
    seen.add(abs);
    result.push(
      entry.title !== undefined ? { source: abs, title: entry.title.trim() } : { source: abs },
    );
  }

  if (result.length === 0) {
    throw new Error("~/.basou/protocols.yaml has no protocols.");
  }
  return result;
}
