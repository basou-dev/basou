import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AmbiguousIdError,
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
  type WorkspaceNotFoundError,
} from "./index.js";

describe("@basou/sdk surface", () => {
  it("exposes BASOU_SDK_VERSION as 0.8.0 (makes the error classes nominal)", () => {
    expect(BASOU_SDK_VERSION).toBe("0.8.0");
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

  it("types each error class nominally, so no other class stands in for it (compile-time)", () => {
    // Without a brand these were all assignable: each pair below has the same
    // public shape, so a field added to either class later would have broken
    // a consumer's compilation.
    expectTypeOf<TaskStoreUnsafeError>().not.toExtend<SessionStoreUnsafeError>();
    expectTypeOf<SessionStoreUnsafeError>().not.toExtend<ApprovalStoreUnsafeError>();
    expectTypeOf<StoreUnsafeError>().not.toExtend<TaskStoreUnsafeError>();
    expectTypeOf<StoreUnsafeError>().not.toExtend<WorkspaceNotFoundError>();
    expectTypeOf<WorkspaceNotFoundError>().not.toExtend<StoreUnsafeError>();
    expectTypeOf<BasouSdkError>().not.toExtend<AmbiguousIdError>();
    expectTypeOf<Error>().not.toExtend<BasouSdkError>();
    expectTypeOf<Error & { input: string }>().not.toExtend<AmbiguousIdError>();
    expectTypeOf<{
      name: string;
      message: string;
      root: string;
    }>().not.toExtend<SessionStoreUnsafeError>();
    // A subclass still stands in for its parents.
    expectTypeOf<TaskStoreUnsafeError>().toExtend<StoreUnsafeError>();
    expectTypeOf<StoreUnsafeError>().toExtend<BasouSdkError>();
    expectTypeOf<AmbiguousIdError>().toExtend<BasouSdkError>();
    expectTypeOf<WorkspaceNotFoundError>().toExtend<Error>();
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
