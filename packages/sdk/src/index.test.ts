import { describe, expect, expectTypeOf, it } from "vitest";
import * as sdk from "./index.js";
import {
  AmbiguousIdError,
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
  WorkspaceNotFoundError,
} from "./index.js";

type Exports = typeof sdk;
/** The name of every error class the SDK exports. */
type ErrorClassName = {
  [K in keyof Exports]: Exports[K] extends abstract new (...args: never) => Error ? K : never;
}[keyof Exports];
type Instance<K extends keyof Exports> = Exports[K] extends abstract new (
  ...args: never
) => infer I
  ? I
  : never;
/** `A -> B` for every pair of exported error classes where an A is assignable to a B. */
type Assignable = {
  [A in ErrorClassName]: {
    [B in Exclude<ErrorClassName, A>]: [Instance<A>] extends [Instance<B>] ? `${A} -> ${B}` : never;
  }[Exclude<ErrorClassName, A>];
}[ErrorClassName];

const ERROR_CLASS_NAMES = [
  "AmbiguousIdError",
  "ApprovalStoreUnsafeError",
  "BasouSdkError",
  "SessionStoreUnsafeError",
  "StoreUnsafeError",
  "TaskStoreUnsafeError",
  "WorkspaceNotFoundError",
] as const;

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
    expectTypeOf<BasouSdkError & { input: string }>().not.toExtend<AmbiguousIdError>();
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

  it("makes a class assignable only to its own parents, over every exported error class (compile-time)", () => {
    // A class added without a brand of its own would be assignable to or from
    // a class it does not extend, and appear here; so would one the list
    // below does not name. Add a new class's edges only once it is branded.
    expectTypeOf<ErrorClassName>().toEqualTypeOf<(typeof ERROR_CLASS_NAMES)[number]>();
    expectTypeOf<Assignable>().toEqualTypeOf<
      | "WorkspaceNotFoundError -> BasouSdkError"
      | "StoreUnsafeError -> BasouSdkError"
      | "SessionStoreUnsafeError -> StoreUnsafeError"
      | "SessionStoreUnsafeError -> BasouSdkError"
      | "TaskStoreUnsafeError -> StoreUnsafeError"
      | "TaskStoreUnsafeError -> BasouSdkError"
      | "ApprovalStoreUnsafeError -> StoreUnsafeError"
      | "ApprovalStoreUnsafeError -> BasouSdkError"
      | "AmbiguousIdError -> BasouSdkError"
    >();
  });

  it("keeps each brand private, out of reach of a consumer's subclass, and emits no field for it", () => {
    // A public or protected brand would compile here, which leaves the
    // expect-error directive above it unused and fails the typecheck.
    class SessionProbe extends SessionStoreUnsafeError {
      brands(): unknown[] {
        return [
          // @ts-expect-error the brand is private to BasouSdkError
          this.__basouSdkError,
          // @ts-expect-error the brand is private to StoreUnsafeError
          this.__storeUnsafe,
          // @ts-expect-error the brand is private to SessionStoreUnsafeError
          this.__sessionStoreUnsafe,
        ];
      }
    }
    class TaskProbe extends TaskStoreUnsafeError {
      brands(): unknown[] {
        // @ts-expect-error the brand is private to TaskStoreUnsafeError
        return [this.__taskStoreUnsafe];
      }
    }
    class ApprovalProbe extends ApprovalStoreUnsafeError {
      brands(): unknown[] {
        // @ts-expect-error the brand is private to ApprovalStoreUnsafeError
        return [this.__approvalStoreUnsafe];
      }
    }
    class WorkspaceProbe extends WorkspaceNotFoundError {
      brands(): unknown[] {
        // @ts-expect-error the brand is private to WorkspaceNotFoundError
        return [this.__workspaceNotFound];
      }
    }
    class AmbiguousProbe extends AmbiguousIdError {
      brands(): unknown[] {
        // @ts-expect-error the brand is private to AmbiguousIdError
        return [this.__ambiguousId];
      }
    }
    expect(new SessionProbe("/r", "m").brands()).toEqual([undefined, undefined, undefined]);
    expect(new TaskProbe("/r", "m").brands()).toEqual([undefined]);
    expect(new ApprovalProbe("/r", "m").brands()).toEqual([undefined]);
    expect(new WorkspaceProbe("/r").brands()).toEqual([undefined]);
    expect(new AmbiguousProbe("x").brands()).toEqual([undefined]);
    expect(Object.keys(new SessionProbe("/r", "m")).sort()).toEqual(["name", "root"]);
  });

  it("names each error class it exports with a string, kept when a build renames the class", () => {
    const errorClasses = Object.entries(sdk as Record<string, unknown>).filter(
      (entry): entry is [string, new (first: string, second: string) => Error] =>
        typeof entry[1] === "function" && entry[1].prototype instanceof Error,
    );
    expect(errorClasses.map(([key]) => key).sort()).toEqual([...ERROR_CLASS_NAMES]);
    for (const [key, ErrorClass] of errorClasses) {
      const original = Object.getOwnPropertyDescriptor(ErrorClass, "name");
      // What a minifier does to a class: the class stays, its name changes.
      Object.defineProperty(ErrorClass, "name", { value: "o", configurable: true });
      try {
        expect(new ErrorClass("/r", "m").name, key).toBe(key);
      } finally {
        if (original !== undefined) Object.defineProperty(ErrorClass, "name", original);
      }
    }
    // A consumer's subclass keeps its own class name.
    class MyStoreError extends StoreUnsafeError {}
    expect(new MyStoreError("/r", "m").name).toBe("MyStoreError");
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
