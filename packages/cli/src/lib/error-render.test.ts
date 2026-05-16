import { FailedToFinalizeError } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ErrorClassifier,
  extractCauseLabel,
  failedToFinalizeClassifier,
  isVerbose,
  printReplayWarning,
  printSessionListSkip,
  printSessionSkip,
  printTaskSkip,
  renderCliError,
  shortSessionId,
  shortTaskId,
} from "./error-render.js";

function captureStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------
// short-id helpers
// ----------------------------------------------------------------------------

describe("shortSessionId", () => {
  it("strips the ses_ prefix and slices the first 6 chars", () => {
    expect(shortSessionId("ses_01HXABCDEFG1234567890ABCDE")).toBe("01HXAB");
  });

  it("slices from offset 0 when there is no prefix", () => {
    expect(shortSessionId("01HXABCDEFG1234567890ABCDE")).toBe("01HXAB");
  });
});

describe("shortTaskId", () => {
  it("strips the task_ prefix and slices the first 6 chars", () => {
    expect(shortTaskId("task_01HXABCDEFG1234567890ABCDE")).toBe("01HXAB");
  });

  it("slices from offset 0 when there is no prefix", () => {
    expect(shortTaskId("01HXABCDEFG1234567890ABCDE")).toBe("01HXAB");
  });
});

// ----------------------------------------------------------------------------
// isVerbose
// ----------------------------------------------------------------------------

describe("isVerbose", () => {
  const originalEnv = process.env.BASOU_DEBUG;

  beforeEach(() => {
    // Tests assert behavior when BASOU_DEBUG is absent; `= undefined` would
    // coerce to the string "undefined" in process.env, so `delete` is the
    // only correct way to clear the key.
    // biome-ignore lint/performance/noDelete: env-var absence is semantically meaningful
    delete process.env.BASOU_DEBUG;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: restoring the original absence
      delete process.env.BASOU_DEBUG;
    } else {
      process.env.BASOU_DEBUG = originalEnv;
    }
  });

  it("returns true when options.verbose is true", () => {
    expect(isVerbose({ verbose: true })).toBe(true);
  });

  it("returns false when options.verbose is false / missing", () => {
    expect(isVerbose({ verbose: false })).toBe(false);
    expect(isVerbose({})).toBe(false);
  });

  it("returns true when BASOU_DEBUG=1 even if options.verbose is false", () => {
    process.env.BASOU_DEBUG = "1";
    expect(isVerbose({ verbose: false })).toBe(true);
  });

  it("returns false for an undefined options argument with no env override", () => {
    expect(isVerbose(undefined)).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// extractCauseLabel
// ----------------------------------------------------------------------------

describe("extractCauseLabel", () => {
  it("returns the direct cause's errno code", () => {
    const err = new Error("outer", {
      cause: Object.assign(new Error("inner"), { code: "ENOENT" }),
    });
    expect(extractCauseLabel(err)).toBe("ENOENT");
  });

  it("walks the chain and returns the first nested code", () => {
    const inner = Object.assign(new Error("native"), { code: "EACCES" });
    const wrapper = new Error("wrapper", { cause: inner });
    const outer = new Error("outer", { cause: wrapper });
    expect(extractCauseLabel(outer)).toBe("EACCES");
  });

  it("falls back to the deepest constructor name when no code is found", () => {
    class WrapperError extends Error {}
    const inner = new WrapperError("native");
    const outer = new Error("outer", { cause: inner });
    expect(extractCauseLabel(outer)).toBe("WrapperError");
  });

  it("returns undefined when the cause is not an Error", () => {
    const err = new Error("outer", { cause: "not an error" });
    expect(extractCauseLabel(err)).toBeUndefined();
  });

  it("stops walking after 4 hops", () => {
    // Build a 5-deep chain with no code anywhere. extractCauseLabel should
    // return the constructor name reached at depth 4 (= 4th hop) rather
    // than walking indefinitely.
    class L1 extends Error {}
    class L2 extends Error {}
    class L3 extends Error {}
    class L4 extends Error {}
    class L5 extends Error {}
    const l5 = new L5("level 5");
    const l4 = new L4("level 4", { cause: l5 });
    const l3 = new L3("level 3", { cause: l4 });
    const l2 = new L2("level 2", { cause: l3 });
    const l1 = new L1("level 1", { cause: l2 });
    const outer = new Error("outer", { cause: l1 });
    // Depth 0: l1 (L1) -> no code -> walk to l2
    // Depth 1: l2 (L2) -> no code -> walk to l3
    // Depth 2: l3 (L3) -> no code -> walk to l4
    // Depth 3: l4 (L4) -> no code -> walk to l5; record constructorName=L4
    // Loop exits when depth reaches 4 (max).
    expect(extractCauseLabel(outer)).toBe("L4");
  });
});

// ----------------------------------------------------------------------------
// renderCliError
// ----------------------------------------------------------------------------

describe("renderCliError", () => {
  it("prints the error message on stderr (non-verbose)", () => {
    const err = captureStderr();
    renderCliError(new Error("boom"), { verbose: false });
    expect(joinCalls(err)).toBe("boom");
  });

  it("coerces non-Error values via String()", () => {
    const err = captureStderr();
    renderCliError("not an error object", { verbose: false });
    expect(joinCalls(err)).toBe("not an error object");
  });

  it("does not emit Caused by: when verbose is false", () => {
    const err = captureStderr();
    renderCliError(
      new Error("boom", { cause: Object.assign(new Error("inner"), { code: "ENOENT" }) }),
      {
        verbose: false,
      },
    );
    expect(joinCalls(err)).toBe("boom");
  });

  it("emits Caused by: <code> when verbose and the cause has a code", () => {
    const err = captureStderr();
    renderCliError(
      new Error("boom", { cause: Object.assign(new Error("inner"), { code: "ENOENT" }) }),
      { verbose: true },
    );
    expect(joinCalls(err)).toBe("boom\nCaused by: ENOENT");
  });

  it("does not emit Caused by: when the error has no cause even in verbose mode", () => {
    const err = captureStderr();
    renderCliError(new Error("boom"), { verbose: true });
    expect(joinCalls(err)).toBe("boom");
  });

  it("never leaks the cause.message even when it contains an absolute path", () => {
    const err = captureStderr();
    renderCliError(
      new Error("write failed", {
        cause: Object.assign(new Error("EACCES: /Users/secret/.basou/x"), { code: "EACCES" }),
      }),
      { verbose: true },
    );
    const out = joinCalls(err);
    expect(out).toContain("write failed");
    expect(out).toContain("Caused by: EACCES");
    expect(out).not.toContain("/Users/secret");
  });

  it("invokes a matching classifier and prints its additional lines after the main message", () => {
    const classifier: ErrorClassifier = {
      match: (e) => e.message === "match me",
      additionalLines: () => ["line A", "line B"],
    };
    const err = captureStderr();
    renderCliError(new Error("match me"), { verbose: false, classifiers: [classifier] });
    expect(joinCalls(err)).toBe("match me\nline A\nline B");
  });

  it("skips classifiers whose match returns false", () => {
    const classifier: ErrorClassifier = {
      match: () => false,
      additionalLines: () => ["should not print"],
    };
    const err = captureStderr();
    renderCliError(new Error("plain"), { verbose: false, classifiers: [classifier] });
    expect(joinCalls(err)).toBe("plain");
  });

  it("emits classifier lines then Caused by: when verbose is true", () => {
    const classifier: ErrorClassifier = {
      match: () => true,
      additionalLines: () => ["extra"],
    };
    const err = captureStderr();
    renderCliError(
      new Error("boom", { cause: Object.assign(new Error("inner"), { code: "EPERM" }) }),
      { verbose: true, classifiers: [classifier] },
    );
    expect(joinCalls(err)).toBe("boom\nextra\nCaused by: EPERM");
  });
});

// ----------------------------------------------------------------------------
// failedToFinalizeClassifier
// ----------------------------------------------------------------------------

describe("failedToFinalizeClassifier", () => {
  it("matches a FailedToFinalizeError and emits the two warning lines", () => {
    const ftf = new FailedToFinalizeError(
      "ses_01HXABCDEFG1234567890ABCDE" as `ses_${string}`,
      "evt_01HXABCDEFG1234567890ABCDE" as `evt_${string}`,
      new Error("inner failure"),
    );
    expect(failedToFinalizeClassifier.match(ftf)).toBe(true);
    const lines = failedToFinalizeClassifier.additionalLines(ftf);
    expect(lines[0]).toBe(
      "Recorded evt_01HXABCDEFG1234567890ABCDE in session 01HXAB; do not rerun",
    );
    expect(lines[1]).toBe("Warning: session.yaml status update failed; events.jsonl is consistent");
  });

  it("does not match unrelated errors", () => {
    expect(failedToFinalizeClassifier.match(new Error("anything else"))).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// printReplayWarning
// ----------------------------------------------------------------------------

describe("printReplayWarning", () => {
  it("prints the partial_trailing_line variant", () => {
    const err = captureStderr();
    printReplayWarning(
      { kind: "partial_trailing_line", line: 3 },
      "ses_01HXABCDEFG1234567890ABCDE",
    );
    expect(joinCalls(err)).toBe("Warning: ignored partial trailing line in 01HXAB/events.jsonl");
  });

  it("prints the malformed_json variant with the offending line number", () => {
    const err = captureStderr();
    printReplayWarning(
      { kind: "malformed_json", line: 7, cause: new Error("bad json") },
      "ses_01HXABCDEFG1234567890ABCDE",
    );
    expect(joinCalls(err)).toBe("Warning: skipped malformed JSON at line 7 in 01HXAB/events.jsonl");
  });

  it("prints the schema_violation variant", () => {
    const err = captureStderr();
    printReplayWarning(
      { kind: "schema_violation", line: 12, cause: new Error("schema fail") },
      "ses_01HXABCDEFG1234567890ABCDE",
    );
    expect(joinCalls(err)).toBe("Warning: skipped invalid event at line 12 in 01HXAB/events.jsonl");
  });
});

// ----------------------------------------------------------------------------
// printSessionSkip / printSessionListSkip
// ----------------------------------------------------------------------------

describe("printSessionSkip", () => {
  it("uses the suspect-check wording for events_jsonl_unreadable", () => {
    const err = captureStderr();
    printSessionSkip("ses_01HXABCDEFG1234567890ABCDE", "events_jsonl_unreadable");
    expect(joinCalls(err)).toBe(
      "Warning: skipped suspect check for 01HXAB: events.jsonl unreadable",
    );
  });

  it("falls through to the raw enum form for other reasons", () => {
    const err = captureStderr();
    printSessionSkip("ses_01HXABCDEFG1234567890ABCDE", "session_yaml_missing");
    expect(joinCalls(err)).toBe("Skipped 01HXAB: session_yaml_missing");
  });
});

describe("printSessionListSkip", () => {
  it("maps session_yaml_missing to friendly English", () => {
    const err = captureStderr();
    printSessionListSkip("ses_01HXABCDEFG1234567890ABCDE", "session_yaml_missing");
    expect(joinCalls(err)).toBe("Skipped 01HXAB: session.yaml not found");
  });

  it("maps session_yaml_invalid to friendly English", () => {
    const err = captureStderr();
    printSessionListSkip("ses_01HXABCDEFG1234567890ABCDE", "session_yaml_invalid");
    expect(joinCalls(err)).toBe("Skipped 01HXAB: invalid session schema");
  });

  it("uses the suspect-check wording for events_jsonl_unreadable", () => {
    const err = captureStderr();
    printSessionListSkip("ses_01HXABCDEFG1234567890ABCDE", "events_jsonl_unreadable");
    expect(joinCalls(err)).toBe(
      "Warning: skipped suspect check for 01HXAB: events.jsonl unreadable",
    );
  });
});

// ----------------------------------------------------------------------------
// printTaskSkip
// ----------------------------------------------------------------------------

describe("printTaskSkip", () => {
  it("formats the skip line with the short task id and reason string", () => {
    const err = captureStderr();
    printTaskSkip("task_01HXABCDEFG1234567890ABCDE", "task_file_invalid");
    expect(joinCalls(err)).toBe("Skipped 01HXAB: task_file_invalid");
  });

  it("accepts a free-form reason string", () => {
    const err = captureStderr();
    printTaskSkip("task_01HXABCDEFG1234567890ABCDE", "custom reason text");
    expect(joinCalls(err)).toBe("Skipped 01HXAB: custom reason text");
  });
});
