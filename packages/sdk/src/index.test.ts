import { describe, expect, it } from "vitest";
import {
  BASOU_SDK_VERSION,
  normalizeIsoTimestamp,
  openWorkspace,
  readObservedDuration,
  resolveWorkspaceRoot,
} from "./index.js";

describe("@basou/sdk surface", () => {
  it("exposes BASOU_SDK_VERSION as 0.5.0 (adds normalizeIsoTimestamp)", () => {
    expect(BASOU_SDK_VERSION).toBe("0.5.0");
  });

  it("re-exports the read rule for a stored timestamp without seconds", () => {
    expect(normalizeIsoTimestamp("2026-09-16T01:23Z")).toBe("2026-09-16T01:23:00Z");
    expect(normalizeIsoTimestamp("2026-09-16T01:23+09:00")).toBe("2026-09-16T01:23:00+09:00");
  });

  it("re-exports the duration read rule, so a consumer need not depend on @basou/core", () => {
    // The field is `number | null` AND a stored 0 means "not observed", so
    // reading it off the event is wrong on both counts.
    expect(typeof readObservedDuration).toBe("function");
  });

  it("exports the workspace entry points", () => {
    expect(typeof openWorkspace).toBe("function");
    expect(typeof resolveWorkspaceRoot).toBe("function");
  });
});
