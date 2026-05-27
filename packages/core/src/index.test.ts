import { describe, expect, it } from "vitest";
import {
  appendBasouGitignore,
  assertBasouRootSafe,
  BASOU_CORE_VERSION,
  basouPaths,
  buildStatusSnapshot,
  ChildProcessRunner,
  createManifest,
  ensureBasouDirectory,
  findErrorCode,
  type GitSnapshot,
  getSnapshot,
  readManifest,
  readStatus,
  readYamlFile,
  resolveRepositoryRoot,
  StatusSchema,
  tryRemoteUrl,
  writeManifest,
  writeStatus,
  writeYamlFile,
} from "./index.js";

describe("@basou/core skeleton", () => {
  it("exposes BASOU_CORE_VERSION as 0.1.0", () => {
    expect(BASOU_CORE_VERSION).toBe("0.1.0");
  });

  it("re-exports basouPaths from storage", () => {
    expect(basouPaths).toBeTypeOf("function");
  });

  it("re-exports ensureBasouDirectory from storage", () => {
    expect(ensureBasouDirectory).toBeTypeOf("function");
  });

  it("re-exports yaml-store APIs from storage", () => {
    expect(readYamlFile).toBeTypeOf("function");
    expect(writeYamlFile).toBeTypeOf("function");
  });

  it("re-exports manifest APIs from storage", () => {
    expect(createManifest).toBeTypeOf("function");
    expect(readManifest).toBeTypeOf("function");
    expect(writeManifest).toBeTypeOf("function");
  });

  it("re-exports appendBasouGitignore from storage", () => {
    expect(appendBasouGitignore).toBeTypeOf("function");
  });

  it("re-exports StatusSchema from schemas", () => {
    expect(StatusSchema.parse).toBeTypeOf("function");
  });

  it("re-exports status storage APIs", () => {
    expect(assertBasouRootSafe).toBeTypeOf("function");
    expect(buildStatusSnapshot).toBeTypeOf("function");
    expect(writeStatus).toBeTypeOf("function");
    expect(readStatus).toBeTypeOf("function");
    expect(findErrorCode).toBeTypeOf("function");
  });

  it("re-exports ChildProcessRunner from runtime", () => {
    expect(ChildProcessRunner).toBeTypeOf("function");
    const runner = new ChildProcessRunner();
    expect(typeof runner.run).toBe("function");
  });

  it("re-exports git capability functions from git/snapshot", () => {
    expect(resolveRepositoryRoot).toBeTypeOf("function");
    expect(tryRemoteUrl).toBeTypeOf("function");
    expect(getSnapshot).toBeTypeOf("function");
  });

  it("re-exports the GitSnapshot type from git/snapshot", () => {
    // Compile-time only: if the type is missing, this assignment fails to typecheck.
    const sample: GitSnapshot = {
      head: "deadbeef",
      branch: "main",
      dirty: false,
      staged: [],
      unstaged: [],
      untracked: [],
    };
    expect(sample.dirty).toBe(false);
  });
});
