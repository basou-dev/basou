import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readYamlFile } from "@basou/core";

/**
 * Local registry for federated, multi-host orientation (`basou orient`). Each
 * entry points at ANOTHER host's `.basou` store as it is reachable on THIS
 * machine as a LOCAL path — an SSHFS mount, an rsync / Syncthing mirror, etc.
 * basou performs NO network I/O: the operator's own tooling (over the SSH they
 * already use) keeps these paths in sync. Like `portfolio.yaml`, this is local
 * machine config, NOT provenance/trail data — it is never committed into a
 * monitored repo, so absolute paths are required.
 *
 * Shape:
 *   version: 1            # optional, reserved for future migrations
 *   hosts:
 *     - label: laptop                  # required, non-empty, distinct (the host tag)
 *       path: ~/mirrors/laptop/myrepo  # required, absolute (~ ok) — the repo
 *                                      # root (the parent of its `.basou`)
 */
export type HostMirror = { label: string; path: string };

/** Canonical location of the hosts registry. */
export const DEFAULT_HOSTS_CONFIG_PATH = join(homedir(), ".basou", "hosts.yaml");

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
 * Read `~/.basou/hosts.yaml` (or an injected path for tests).
 *
 * Returns `null` when the file is ABSENT: `orient` is the default command, so a
 * missing registry must be silent ("no federation") — unlike the explicit
 * `--portfolio`, whose loader throws. A present-but-malformed file THROWS a
 * pathless, user-facing message so the caller can warn and fall back to
 * local-only. Each `path` is `~`-expanded, required absolute, and de-duped by
 * resolved path (first occurrence wins, keeping its label and order). Labels
 * must be distinct (orientation collapses hosts by label). An empty `hosts:`
 * list returns `[]` (benign no-op, not an error).
 */
export async function loadHostsConfig(
  configPath: string = DEFAULT_HOSTS_CONFIG_PATH,
): Promise<HostMirror[] | null> {
  let raw: unknown;
  try {
    raw = await readYamlFile(configPath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") {
      return null;
    }
    if (error instanceof Error && error.message === "Failed to parse YAML content") {
      throw new Error("~/.basou/hosts.yaml is not valid YAML.");
    }
    throw error;
  }

  if (!isRecord(raw) || !Array.isArray(raw.hosts)) {
    throw new Error("~/.basou/hosts.yaml must contain a 'hosts:' list.");
  }

  const seenPaths = new Set<string>();
  const seenLabels = new Set<string>();
  const result: HostMirror[] = [];
  for (const entry of raw.hosts) {
    if (!isRecord(entry) || typeof entry.label !== "string" || entry.label.trim().length === 0) {
      throw new Error("Each host needs a non-empty string 'label'.");
    }
    const label = entry.label.trim();
    if (typeof entry.path !== "string" || entry.path.trim().length === 0) {
      throw new Error("Each host needs a non-empty string 'path'.");
    }
    const expanded = expandTilde(entry.path.trim());
    if (!isAbsolute(expanded)) {
      throw new Error("Host paths must be absolute (or start with '~').");
    }
    const abs = resolve(expanded);
    if (seenPaths.has(abs)) continue;
    // Distinct mirrors must have distinct labels: orientation collapses hosts by
    // label (a Set), so a duplicate would make two stores indistinguishable.
    if (seenLabels.has(label)) {
      throw new Error(`Duplicate host label '${label}'; each host needs a distinct label.`);
    }
    seenPaths.add(abs);
    seenLabels.add(label);
    result.push({ label, path: abs });
  }

  return result;
}
