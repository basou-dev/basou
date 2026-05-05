import { describe, expect, it } from "vitest";
import { BASOU_CORE_VERSION, basouPaths, ensureBasouDirectory } from "./index.js";

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
});
