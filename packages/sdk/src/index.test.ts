import { describe, expect, it } from "vitest";
import { BASOU_SDK_VERSION, openWorkspace, resolveWorkspaceRoot } from "./index.js";

describe("@basou/sdk surface", () => {
  it("exposes BASOU_SDK_VERSION as 0.3.0 (adds Workspace.renderReport)", () => {
    expect(BASOU_SDK_VERSION).toBe("0.3.0");
  });

  it("exports the workspace entry points", () => {
    expect(typeof openWorkspace).toBe("function");
    expect(typeof resolveWorkspaceRoot).toBe("function");
  });
});
