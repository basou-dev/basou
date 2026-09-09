import { describe, expect, it } from "vitest";
import { isTransientToolPath } from "./transient-paths.js";

const TEMP = "/var/folders/ab/cdef/T";

describe("isTransientToolPath", () => {
  // The shape that puts a workspace name into a position: a scratch directory
  // named after the session's own working directory.
  it("matches an agent's per-session scratch directory", () => {
    expect(
      isTransientToolPath(
        "/private/tmp/claude-501/-home-tester-projects-beta-workspace/abc/scratchpad/n.md",
        TEMP,
      ),
    ).toBe(true);
    expect(
      isTransientToolPath("/tmp/claude-501/-home-tester-projects-beta-workspace/x", TEMP),
    ).toBe(true);
  });

  it("matches the platform temp directory in either spelling", () => {
    expect(isTransientToolPath(`${TEMP}/build-abc/out.txt`, TEMP)).toBe(true);
    expect(isTransientToolPath(`/private${TEMP}/build-abc/out.txt`, TEMP)).toBe(true);
  });

  it("matches the fixed temp roots and their private aliases", () => {
    for (const p of ["/tmp/x", "/private/tmp/x", "/var/tmp/x", "/private/var/tmp/x"]) {
      expect(isTransientToolPath(p, TEMP)).toBe(true);
    }
  });

  it("matches a temp root itself, not just paths under it", () => {
    expect(isTransientToolPath("/tmp", TEMP)).toBe(true);
  });

  // The paths a position exists to report: the sanitizer has already made them
  // repo-relative or tilde-prefixed, so they are inside the workspace or home.
  it("keeps repo-relative and tilde paths", () => {
    expect(isTransientToolPath("packages/core/src/index.ts", TEMP)).toBe(false);
    expect(isTransientToolPath("~/projects/alpha-planning/AGENTS.md", TEMP)).toBe(false);
    expect(isTransientToolPath(".", TEMP)).toBe(false);
  });

  it("keeps an absolute path outside every temp root", () => {
    expect(isTransientToolPath("/home/tester/projects/alpha-planning/x.md", TEMP)).toBe(false);
    expect(isTransientToolPath("/etc/hosts", TEMP)).toBe(false);
  });

  // A sibling whose name merely starts with a temp root's name is not under it.
  it("does not match a sibling of a temp root by prefix", () => {
    expect(isTransientToolPath("/tmpfoo/x", TEMP)).toBe(false);
    expect(isTransientToolPath("/var/tmpfoo/x", TEMP)).toBe(false);
  });
});
