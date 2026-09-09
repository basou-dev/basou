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
    const tail = "claude-501/-home-tester-projects-beta-workspace/ab/scratchpad/n.md";
    expect(isTransientToolPath(`${TEMP}/${tail}`, TEMP)).toBe(true);
    expect(isTransientToolPath(`/private${TEMP}/${tail}`, TEMP)).toBe(true);
  });

  it("matches under the fixed temp roots and their private aliases", () => {
    const tail = "claude-501/-home-tester-projects-beta-workspace/x";
    for (const root of ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]) {
      expect(isTransientToolPath(`${root}/${tail}`, TEMP)).toBe(true);
    }
  });

  // Being under a temp root is not enough. A workspace can live under one — a
  // checkout in /tmp, and every test fixture built with mkdtemp — and emptying
  // its summary would defeat the purpose of the summary.
  it("keeps a workspace that merely lives under a temp root", () => {
    expect(isTransientToolPath("/tmp/my-checkout/src/index.ts", TEMP)).toBe(false);
    expect(isTransientToolPath(`${TEMP}/basou-test-a1b2/beta-planning/notes.md`, TEMP)).toBe(false);
    expect(isTransientToolPath("/tmp", TEMP)).toBe(false);
    expect(isTransientToolPath(`${TEMP}/build-abc/out.txt`, TEMP)).toBe(false);
  });

  // The encoded name is an absolute path with every separator turned into a
  // dash, so a directory that merely starts with one is not mistaken for it.
  it("does not mistake a dash-prefixed directory for an encoded working directory", () => {
    expect(isTransientToolPath("/tmp/-scratch/x.md", TEMP)).toBe(false);
    expect(isTransientToolPath("/tmp/-a-b/x.md", TEMP)).toBe(false);
    expect(isTransientToolPath("/tmp/-a-b-c/x.md", TEMP)).toBe(true);
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
    // An encoded name outside a temp root is not a scratch path either.
    expect(isTransientToolPath("/home/tester/-home-tester-projects-x/n.md", TEMP)).toBe(false);
  });

  // A sibling whose name merely starts with a temp root's name is not under it.
  it("does not match a sibling of a temp root by prefix", () => {
    const tail = "claude-501/-home-tester-projects-beta-workspace/x";
    expect(isTransientToolPath(`/tmpfoo/${tail}`, TEMP)).toBe(false);
    expect(isTransientToolPath(`/var/tmpfoo/${tail}`, TEMP)).toBe(false);
  });
});
