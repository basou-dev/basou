import { describe, expect, it } from "vitest";
import {
  BASOU_CORE_VERSION,
  appendBasouGitignore,
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  readManifest,
  readYamlFile,
  writeManifest,
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
});
