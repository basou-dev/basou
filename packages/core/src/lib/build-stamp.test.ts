import { describe, expect, it } from "vitest";
import { BASOU_CORE_BUILD, parseBuildStamp } from "./build-stamp.js";

describe("parseBuildStamp", () => {
  it("reads a well-formed stamp", () => {
    const raw = JSON.stringify({
      version: "1.2.3",
      commit: "abc1234",
      committedAt: "2026-05-10T09:00:00+09:00",
    });
    expect(parseBuildStamp(raw)).toEqual({
      version: "1.2.3",
      commit: "abc1234",
      committedAt: "2026-05-10T09:00:00+09:00",
    });
  });

  it("keeps a -dirty marker, which is the whole point of carrying one", () => {
    const raw = JSON.stringify({
      version: "1.2.3",
      commit: "abc1234-dirty",
      committedAt: "2026-05-10T09:00:00+09:00",
    });
    expect(parseBuildStamp(raw)?.commit).toBe("abc1234-dirty");
  });

  // Anything unparseable yields `undefined` rather than throwing: a malformed
  // stamp must not stop the CLI from starting.
  it.each([
    ["no stamp at all (loaded from source)", undefined],
    ["not JSON", "{"],
    ["JSON that is not an object", '"a string"'],
    ["an object missing commit", '{"version":"1.2.3","committedAt":"2026-05-10T09:00:00Z"}'],
    ["an object whose version is not a string", '{"version":1,"commit":"a","committedAt":"b"}'],
  ])("returns undefined for %s", (_label, raw) => {
    expect(parseBuildStamp(raw)).toBeUndefined();
  });

  it("is undefined when this module is loaded from source", () => {
    // Under vitest there is no build, so there is nothing to be stale — and
    // the constant must say so rather than inventing an identity.
    expect(BASOU_CORE_BUILD).toBeUndefined();
  });
});
