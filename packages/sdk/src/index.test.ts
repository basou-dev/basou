import { describe, expect, it } from "vitest";
import { BASOU_SDK_VERSION } from "./index.js";

describe("@basou/sdk skeleton", () => {
  it("exposes BASOU_SDK_VERSION as 0.1.0", () => {
    expect(BASOU_SDK_VERSION).toBe("0.1.0");
  });
});
