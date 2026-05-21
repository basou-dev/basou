import { describe, expect, it } from "vitest";
import { sanitizePath, sanitizeRelatedFiles, sanitizeWorkingDirectory } from "./path-sanitizer.js";

const WD = "/Users/u/projects/foo";
const HOME = "/Users/u";

describe("sanitizePath", () => {
  it("rewrites a workingDirectory-internal absolute path as a relative path", () => {
    expect(
      sanitizePath("/Users/u/projects/foo/src/x.ts", { workingDirectory: WD, homedir: HOME }),
    ).toBe("src/x.ts");
  });

  it("rewrites the workingDirectory itself as '.'", () => {
    expect(sanitizePath(WD, { workingDirectory: WD, homedir: HOME })).toBe(".");
  });

  it("rewrites a homedir-internal absolute path with the ~/ prefix", () => {
    expect(sanitizePath("/Users/u/notes/secret.md", { workingDirectory: WD, homedir: HOME })).toBe(
      "~/notes/secret.md",
    );
  });

  it("rewrites the homedir itself as '~'", () => {
    expect(sanitizePath(HOME, { workingDirectory: WD, homedir: HOME })).toBe("~");
  });

  it("prefers workingDirectory over homedir when both prefixes match", () => {
    // /Users/u/projects/foo is both homedir-internal AND workingDirectory.
    // Step (1) wins; we expect a repo-relative rewrite, not a `~/projects/foo/...`.
    expect(
      sanitizePath("/Users/u/projects/foo/lib/y.ts", { workingDirectory: WD, homedir: HOME }),
    ).toBe("lib/y.ts");
  });

  it("preserves system paths (= outside both workingDirectory and homedir)", () => {
    expect(sanitizePath("/etc/hosts", { workingDirectory: WD, homedir: HOME })).toBe("/etc/hosts");
  });

  it("preserves already-relative paths verbatim (after normalisation)", () => {
    expect(sanitizePath("src/x.ts", { workingDirectory: WD, homedir: HOME })).toBe("src/x.ts");
  });

  it("collapses '..' segments before matching prefixes", () => {
    // /Users/u/projects/foo/../bar/x.ts normalises to /Users/u/projects/bar/x.ts.
    // That target is homedir-internal but NOT workingDirectory-internal, so we
    // expect the ~/ rewrite, not a `..`-prefixed relative output.
    expect(
      sanitizePath("/Users/u/projects/foo/../bar/x.ts", { workingDirectory: WD, homedir: HOME }),
    ).toBe("~/projects/bar/x.ts");
  });

  it("does NOT pretend a `..`-escape under workingDirectory is repo-internal", () => {
    // After normalisation /Users/u/projects/foo/../../escape is /Users/u/escape.
    // /Users/u/escape is homedir-internal but not workingDirectory-internal, so
    // the rewrite must land in the ~/ rule, never produce a `..`-prefixed rel
    // string that looks like a repo-internal path.
    const result = sanitizePath("/Users/u/projects/foo/../../escape/y.ts", {
      workingDirectory: WD,
      homedir: HOME,
    });
    expect(result).toBe("~/escape/y.ts");
    expect(result.startsWith("..")).toBe(false);
  });

  it("preserves a path that escapes both bases", () => {
    expect(sanitizePath("/var/log/messages", { workingDirectory: WD, homedir: HOME })).toBe(
      "/var/log/messages",
    );
  });

  it("rejects a path containing a null byte", () => {
    expect(() => sanitizePath("src/\0x.ts", { workingDirectory: WD, homedir: HOME })).toThrow(
      "Invalid path: contains null byte",
    );
  });

  it("folds backslashes to forward slashes (POSIX target)", () => {
    expect(sanitizePath("src\\windows\\style\\x.ts", { workingDirectory: WD, homedir: HOME })).toBe(
      "src/windows/style/x.ts",
    );
  });

  it("is robust against a trailing slash on workingDirectory / homedir options", () => {
    expect(
      sanitizePath("/Users/u/projects/foo/src/x.ts", {
        workingDirectory: `${WD}/`,
        homedir: `${HOME}/`,
      }),
    ).toBe("src/x.ts");
  });

  it("handles an empty string by returning an empty string (no schema check here)", () => {
    // Empty is a degenerate input; the schema layer rejects empty entries,
    // but the sanitizer itself should not crash. path.posix.normalize("") = ".".
    expect(sanitizePath("", { workingDirectory: WD, homedir: HOME })).toBe(".");
  });
});

describe("sanitizeWorkingDirectory", () => {
  it("delegates to sanitizePath (= identical behaviour)", () => {
    expect(sanitizeWorkingDirectory(WD, { workingDirectory: WD, homedir: HOME })).toBe(".");
    expect(sanitizeWorkingDirectory(HOME, { workingDirectory: WD, homedir: HOME })).toBe("~");
    expect(sanitizeWorkingDirectory("/etc", { workingDirectory: WD, homedir: HOME })).toBe("/etc");
  });
});

describe("sanitizeRelatedFiles", () => {
  it("sanitizes every entry and counts the mutations", () => {
    const result = sanitizeRelatedFiles(
      [
        "/Users/u/projects/foo/src/a.ts",
        "/Users/u/notes/b.md",
        "/etc/hosts",
        "already/relative.ts",
      ],
      { workingDirectory: WD, homedir: HOME },
    );
    expect(result.sanitized).toEqual([
      "src/a.ts",
      "~/notes/b.md",
      "/etc/hosts",
      "already/relative.ts",
    ]);
    expect(result.mutationCount).toBe(2);
  });

  it("reports mutationCount=0 when no entry changed shape", () => {
    const result = sanitizeRelatedFiles(["src/a.ts", "lib/b.ts"], {
      workingDirectory: WD,
      homedir: HOME,
    });
    expect(result.mutationCount).toBe(0);
    expect(result.sanitized).toEqual(["src/a.ts", "lib/b.ts"]);
  });

  it("preserves duplicates (= deduplication is the caller's responsibility)", () => {
    const result = sanitizeRelatedFiles(
      ["/Users/u/projects/foo/a.ts", "/Users/u/projects/foo/a.ts"],
      { workingDirectory: WD, homedir: HOME },
    );
    expect(result.sanitized).toEqual(["a.ts", "a.ts"]);
    expect(result.mutationCount).toBe(2);
  });

  it("preserves order so caller-side sorts stay deterministic", () => {
    const result = sanitizeRelatedFiles(
      ["/Users/u/projects/foo/b.ts", "/Users/u/projects/foo/a.ts"],
      { workingDirectory: WD, homedir: HOME },
    );
    expect(result.sanitized).toEqual(["b.ts", "a.ts"]);
  });

  it("rejects a null byte in any entry", () => {
    expect(() =>
      sanitizeRelatedFiles(["src/ok.ts", "src/\0bad.ts"], {
        workingDirectory: WD,
        homedir: HOME,
      }),
    ).toThrow("Invalid path: contains null byte");
  });
});
