import { describe, expect, it } from "vitest";
import {
  ApprovalStoreUnsafeError,
  BASOU_SDK_VERSION,
  BasouSdkError,
  normalizeIsoTimestamp,
  openWorkspace,
  readObservedDuration,
  resolveWorkspaceRoot,
  SessionStoreUnsafeError,
  StoreUnsafeError,
  TaskStoreUnsafeError,
} from "./index.js";

describe("@basou/sdk surface", () => {
  it("exposes BASOU_SDK_VERSION as 0.7.0 (adds StoreUnsafeError and its task / approval subclasses)", () => {
    expect(BASOU_SDK_VERSION).toBe("0.7.0");
  });

  it("exports an error per store that is not followed, under one parent", () => {
    for (const StoreError of [
      SessionStoreUnsafeError,
      TaskStoreUnsafeError,
      ApprovalStoreUnsafeError,
    ]) {
      const error = new StoreError("/r", "m");
      expect(error).toBeInstanceOf(StoreUnsafeError);
      expect(error).toBeInstanceOf(BasouSdkError);
      expect(error.name).toBe(StoreError.name);
      expect(error.root).toBe("/r");
    }
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
