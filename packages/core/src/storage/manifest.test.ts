import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isValidPrefixedId } from "../ids/ulid.js";
import { ensureBasouDirectory } from "./basou-dir.js";
import { createManifest, readManifest, writeManifest } from "./manifest.js";

let repoRoot: string | undefined;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "basou-manifest-test-"));
});

afterEach(async () => {
  if (repoRoot !== undefined) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  }
});

function getRepoRoot(): string {
  if (repoRoot === undefined) throw new Error("repoRoot not initialized");
  return repoRoot;
}

const FIXED_DATE = new Date("2026-05-04T09:00:00.000Z");
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

describe("createManifest", () => {
  it("produces a minimal manifest", () => {
    const manifest = createManifest({
      workspaceName: "client-foo-lp",
      now: FIXED_DATE,
      workspaceId: FIXED_WS_ID,
    });
    expect(manifest.schema_version).toBe("0.1.0");
    expect(manifest.basou_version).toBe("0.1.0");
    expect(manifest.workspace.id).toBe(FIXED_WS_ID);
    expect(manifest.workspace.name).toBe("client-foo-lp");
  });

  it("defaults capabilities.enabled to the v0.1 list", () => {
    const manifest = createManifest({ workspaceName: "x" });
    expect(manifest.capabilities.enabled).toEqual([
      "core",
      "claude-code-adapter",
      "terminal-recording",
      "git-capability",
      "approval",
    ]);
  });

  it("sets approval defaults to required_for + medium", () => {
    const manifest = createManifest({ workspaceName: "x" });
    expect(manifest.approval.required_for).toEqual(["destructive_command", "external_send"]);
    expect(manifest.approval.default_risk_level).toBe("medium");
  });

  it("assigns workspace.id with ws_ prefix and valid ULID", () => {
    const manifest = createManifest({ workspaceName: "x" });
    expect(manifest.workspace.id.startsWith("ws_")).toBe(true);
    expect(isValidPrefixedId(manifest.workspace.id)).toBe(true);
  });

  it("uses provided workspaceId when given", () => {
    const manifest = createManifest({
      workspaceName: "x",
      workspaceId: FIXED_WS_ID,
    });
    expect(manifest.workspace.id).toBe(FIXED_WS_ID);
  });

  it("uses provided now for created_at and updated_at", () => {
    const manifest = createManifest({
      workspaceName: "x",
      now: FIXED_DATE,
    });
    expect(manifest.workspace.created_at).toBe(FIXED_DATE.toISOString());
    expect(manifest.workspace.updated_at).toBe(FIXED_DATE.toISOString());
  });

  it("omits project.name when not provided", () => {
    const manifest = createManifest({ workspaceName: "x" });
    expect("name" in manifest.project).toBe(false);
  });

  it("includes project.name when provided", () => {
    const manifest = createManifest({ workspaceName: "x", projectName: "My Project" });
    expect(manifest.project.name).toBe("My Project");
  });

  it("sets repository_url: null when explicitly null", () => {
    const manifest = createManifest({ workspaceName: "x", repositoryUrl: null });
    expect(manifest.project.repository_url).toBeNull();
  });

  it("omits repository_url when undefined", () => {
    const manifest = createManifest({ workspaceName: "x" });
    expect("repository_url" in manifest.project).toBe(false);
  });

  it("includes import.source_roots when provided (relative paths)", () => {
    const manifest = createManifest({
      workspaceName: "x",
      sourceRoots: [".", "../basou-workspace"],
    });
    expect(manifest.import?.source_roots).toEqual([".", "../basou-workspace"]);
  });

  it("omits the import block when sourceRoots is absent or empty", () => {
    expect("import" in createManifest({ workspaceName: "x" })).toBe(false);
    expect("import" in createManifest({ workspaceName: "x", sourceRoots: [] })).toBe(false);
  });

  it("throws on an absolute source root (schema rejects absolute paths)", () => {
    expect(() =>
      createManifest({ workspaceName: "x", sourceRoots: ["/Users/example/projects/basou"] }),
    ).toThrow();
  });

  it("throws on empty workspaceName", () => {
    expect(() => createManifest({ workspaceName: "" })).toThrow(/Workspace name is empty/);
  });
});

describe("writeManifest / readManifest", () => {
  it("writes YAML at paths.files.manifest and reads back equal", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const manifest = createManifest({
      workspaceName: "x",
      now: FIXED_DATE,
      workspaceId: FIXED_WS_ID,
    });
    await writeManifest(paths, manifest);
    const readBack = await readManifest(paths);
    expect(readBack).toEqual(manifest);
  });

  it("refuses to overwrite without force", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const manifest = createManifest({ workspaceName: "x", workspaceId: FIXED_WS_ID });
    await writeManifest(paths, manifest);
    await expect(writeManifest(paths, manifest)).rejects.toThrow(/Already initialized/);
  });

  it("overwrites with force: true", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const first = createManifest({ workspaceName: "first", workspaceId: FIXED_WS_ID });
    await writeManifest(paths, first);
    const second = createManifest({
      workspaceName: "second",
      workspaceId: "ws_01HXABCDEF1234567890ABCDEG" as const,
    });
    await writeManifest(paths, second, { force: true });
    const readBack = await readManifest(paths);
    expect(readBack.workspace.name).toBe("second");
    expect(readBack.workspace.id).toBe("ws_01HXABCDEF1234567890ABCDEG");
  });

  it("validates manifest before writing (rejects unknown basou_version)", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const manifest = createManifest({ workspaceName: "x", workspaceId: FIXED_WS_ID });
    // biome-ignore lint/suspicious/noExplicitAny: deliberate invalid manifest for negative test
    const broken = { ...manifest, basou_version: "0.2.0" } as any;
    await expect(writeManifest(paths, broken)).rejects.toThrow();
  });

  it("readManifest throws pathless Error when file missing", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    let captured: unknown;
    try {
      await readManifest(paths);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("YAML file not found");
    expect(err.message).not.toContain(getRepoRoot());
  });

  it("readManifest throws when content fails schema validation", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    await writeFile(paths.files.manifest, 'schema_version: "0.2.0"\n', "utf8");
    await expect(readManifest(paths)).rejects.toThrow();
  });

  it("manifest yaml file is round-trip stable across two write/read cycles", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const manifest = createManifest({
      workspaceName: "round-trip",
      projectName: "Round Trip",
      projectDescription: "test",
      repositoryUrl: "https://example.com/foo.git",
      now: FIXED_DATE,
      workspaceId: FIXED_WS_ID,
    });
    await writeManifest(paths, manifest);
    const first = await readManifest(paths);
    await writeManifest(paths, first, { force: true });
    const second = await readManifest(paths);
    expect(second).toEqual(manifest);
  });
});
