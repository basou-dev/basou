import { lstat } from "node:fs/promises";
import { type PrefixedId, prefixedUlid } from "../ids/ulid.js";
import { type Manifest, ManifestSchema } from "../schemas/manifest.schema.js";
import type { BasouPaths } from "./basou-dir.js";
import { readYamlFile, writeYamlFile } from "./yaml-store.js";

/**
 * Inputs for {@link createManifest}. Optional fields drop out of the
 * resulting Manifest entirely (they are not emitted as `null`/`undefined`
 * in YAML); pass `null` for `repositoryUrl` to keep an explicit `null`.
 */
export type CreateManifestInput = {
  workspaceName: string;
  projectName?: string;
  projectDescription?: string;
  repositoryUrl?: string | null;
  /** Override for tests; defaults to `new Date()`. */
  now?: Date;
  /** Override for tests; defaults to a freshly generated `ws_<ULID>`. */
  workspaceId?: PrefixedId<"ws">;
};

/**
 * Build a fresh Manifest object that satisfies the manifest schema's
 * minimum shape. Performs no I/O. Returned object is parse-validated by
 * `ManifestSchema`.
 */
export function createManifest(input: CreateManifestInput): Manifest {
  if (input.workspaceName.length === 0) {
    throw new Error("Workspace name is empty. Pass --name explicitly.");
  }
  const now = (input.now ?? new Date()).toISOString();
  const workspaceId = input.workspaceId ?? prefixedUlid("ws");

  const project: Manifest["project"] = {
    ...(input.projectName !== undefined ? { name: input.projectName } : {}),
    ...(input.projectDescription !== undefined ? { description: input.projectDescription } : {}),
    ...(input.repositoryUrl !== undefined ? { repository_url: input.repositoryUrl } : {}),
  };

  const manifest: Manifest = {
    schema_version: "0.1.0",
    basou_version: "0.1.0",
    workspace: {
      id: workspaceId,
      name: input.workspaceName,
      created_at: now,
      updated_at: now,
    },
    project,
    capabilities: {
      enabled: ["core", "claude-code-adapter", "terminal-recording", "git-capability", "approval"],
    },
    approval: {
      required_for: ["destructive_command", "external_send"],
      default_risk_level: "medium",
    },
    adapters: {
      "claude-code": { enabled: true },
    },
    git: { events_log: "ignore" },
  };
  return ManifestSchema.parse(manifest);
}

/**
 * Write a Manifest to `paths.files.manifest`. Re-validates via
 * `ManifestSchema` before serialization.
 *
 * Refuses to overwrite an existing manifest unless `force: true`.
 */
export async function writeManifest(
  paths: BasouPaths,
  manifest: Manifest,
  options?: { force?: boolean },
): Promise<void> {
  const force = options?.force === true;
  const validated = ManifestSchema.parse(manifest);

  if (!force) {
    let existed = false;
    try {
      await lstat(paths.files.manifest);
      existed = true;
    } catch (error: unknown) {
      if (!hasErrorCode(error) || error.code !== "ENOENT") {
        throw new Error("Failed to inspect existing manifest", { cause: error });
      }
    }
    if (existed) {
      throw new Error("Already initialized. Use --force to overwrite.");
    }
  }

  await writeYamlFile(paths.files.manifest, validated);
}

/**
 * Read and parse a Manifest from `paths.files.manifest`. Throws if the file
 * is missing or contents fail `ManifestSchema` validation.
 */
export async function readManifest(paths: BasouPaths): Promise<Manifest> {
  const raw = await readYamlFile(paths.files.manifest);
  return ManifestSchema.parse(raw);
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  return typeof (error as unknown as Record<string, unknown>).code === "string";
}
