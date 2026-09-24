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

  // On macOS / Linux a backslash is an ordinary filename character, not a
  // separator: `back\slash.txt` is one file, and `back/slash.txt` is a
  // different file in another directory.
  it("keeps a backslash in a relative path as part of the name", () => {
    expect(sanitizePath("back\\slash.txt", { workingDirectory: WD, homedir: HOME })).toBe(
      "back\\slash.txt",
    );
  });

  it("keeps a backslash in a workingDirectory-internal absolute path", () => {
    expect(
      sanitizePath("/Users/u/projects/foo/src/back\\slash.txt", {
        workingDirectory: WD,
        homedir: HOME,
      }),
    ).toBe("src/back\\slash.txt");
  });

  it("does not read a backslash-separated `..` as a parent directory", () => {
    // `a\..\..\b` is one name directly under workingDirectory.
    expect(
      sanitizePath("/Users/u/projects/foo/a\\..\\..\\b", { workingDirectory: WD, homedir: HOME }),
    ).toBe("a\\..\\..\\b");
  });

  it("matches a workingDirectory whose name contains a backslash against that directory only", () => {
    const wd = "/Users/u/we\\ird";
    expect(sanitizePath("/Users/u/we\\ird/src/x.ts", { workingDirectory: wd, homedir: HOME })).toBe(
      "src/x.ts",
    );
    // `/Users/u/we/ird` is a different directory, not under workingDirectory.
    expect(sanitizePath("/Users/u/we/ird/src/x.ts", { workingDirectory: wd, homedir: HOME })).toBe(
      "~/we/ird/src/x.ts",
    );
  });

  it("matches a homedir whose name contains a backslash against that directory only", () => {
    const home = "/home/a\\b";
    expect(sanitizePath("/home/a\\b/notes.md", { workingDirectory: WD, homedir: home })).toBe(
      "~/notes.md",
    );
    expect(sanitizePath("/home/a/b/notes.md", { workingDirectory: WD, homedir: home })).toBe(
      "/home/a/b/notes.md",
    );
  });

  it("passes a Windows-style path through unchanged (Windows is not supported)", () => {
    expect(sanitizePath("C:\\Users\\u\\x.ts", { workingDirectory: WD, homedir: HOME })).toBe(
      "C:\\Users\\u\\x.ts",
    );
  });

  it("does not read a leading backslash as the root", () => {
    // Both are single relative names on POSIX, not `/server/...` or `/Users/...`.
    expect(sanitizePath("\\\\server\\share\\x.ts", { workingDirectory: WD, homedir: HOME })).toBe(
      "\\\\server\\share\\x.ts",
    );
    expect(sanitizePath("\\Users\\u\\x.ts", { workingDirectory: WD, homedir: HOME })).toBe(
      "\\Users\\u\\x.ts",
    );
  });

  it("keeps a backslash in an absolute path outside both bases", () => {
    expect(sanitizePath("/etc/back\\slash", { workingDirectory: WD, homedir: HOME })).toBe(
      "/etc/back\\slash",
    );
  });

  // `path.relative` spells a target outside the base as `..` or `../...`. A
  // name that merely begins with two dots is still inside.
  it("rewrites a name beginning with two dots under workingDirectory as relative", () => {
    for (const name of ["..notes", "..\\x.json", "..\\..\\b", "...", "..cache/x.ts"]) {
      expect(sanitizePath(`${WD}/${name}`, { workingDirectory: WD, homedir: HOME })).toBe(name);
    }
  });

  it("rewrites a name containing or ending with two dots under workingDirectory as relative", () => {
    for (const name of ["foo..", "foo../bar", "a../b"]) {
      expect(sanitizePath(`${WD}/${name}`, { workingDirectory: WD, homedir: HOME })).toBe(name);
    }
  });

  it("rewrites a name beginning with two dots under homedir with the ~/ prefix", () => {
    for (const name of ["..notes", "..\\notes.md", "...", "x.."]) {
      expect(sanitizePath(`${HOME}/${name}`, { workingDirectory: WD, homedir: HOME })).toBe(
        `~/${name}`,
      );
    }
  });

  it("does not rewrite the parent of workingDirectory or of homedir as inside it", () => {
    // `path.relative` returns exactly `..` for these two.
    expect(sanitizePath("/Users/u/projects", { workingDirectory: WD, homedir: HOME })).toBe(
      "~/projects",
    );
    expect(sanitizePath("/Users", { workingDirectory: WD, homedir: HOME })).toBe("/Users");
  });

  it("is robust against a trailing slash on workingDirectory / homedir options", () => {
    expect(
      sanitizePath("/Users/u/projects/foo/src/x.ts", {
        workingDirectory: `${WD}/`,
        homedir: `${HOME}/`,
      }),
    ).toBe("src/x.ts");
  });

  // `path.posix.normalize` keeps a trailing slash, so `<wd>/` and `<wd>` must
  // still be recognised as the same directory, on either side.
  it("rewrites workingDirectory itself as '.' when either side has a trailing slash", () => {
    expect(sanitizePath(`${WD}/`, { workingDirectory: WD, homedir: HOME })).toBe(".");
    expect(sanitizePath(WD, { workingDirectory: `${WD}/`, homedir: HOME })).toBe(".");
  });

  it("rewrites homedir itself as '~' when either side has a trailing slash", () => {
    expect(sanitizePath(`${HOME}/`, { workingDirectory: WD, homedir: HOME })).toBe("~");
    expect(sanitizePath(HOME, { workingDirectory: WD, homedir: `${HOME}/` })).toBe("~");
  });

  it("keeps the output of a path that is not a base unchanged by a trailing slash", () => {
    expect(sanitizePath(`${WD}/src/`, { workingDirectory: WD, homedir: HOME })).toBe("src");
    expect(sanitizePath("/etc/foo/", { workingDirectory: WD, homedir: HOME })).toBe("/etc/foo/");
    expect(sanitizePath("src/", { workingDirectory: WD, homedir: HOME })).toBe("src/");
  });

  it("handles an empty string by returning an empty string (no schema check here)", () => {
    // Empty is a degenerate input; the schema layer rejects empty entries,
    // but the sanitizer itself should not crash. path.posix.normalize("") = ".".
    expect(sanitizePath("", { workingDirectory: WD, homedir: HOME })).toBe(".");
  });
});

describe("sanitizeWorkingDirectory", () => {
  it("rewrites a homedir-internal path with ~/ even when the path equals its own working directory", () => {
    // This is the key semantic difference from sanitizePath: feeding the
    // session's working_directory to sanitizePath with itself as opts.workingDirectory
    // would produce ".", which loses information. sanitizeWorkingDirectory
    // must yield "~/projects/foo" so the persisted field carries homedir
    // context.
    expect(sanitizeWorkingDirectory(WD, { homedir: HOME })).toBe("~/projects/foo");
  });

  it("rewrites the homedir itself as '~'", () => {
    expect(sanitizeWorkingDirectory(HOME, { homedir: HOME })).toBe("~");
  });

  it("preserves a system path that escapes homedir", () => {
    expect(sanitizeWorkingDirectory("/srv/work", { homedir: HOME })).toBe("/srv/work");
  });

  it("preserves an already-relative working_directory (e.g. a test fixture passing '.')", () => {
    expect(sanitizeWorkingDirectory(".", { homedir: HOME })).toBe(".");
  });

  it("keeps a backslash in the working directory's name", () => {
    expect(sanitizeWorkingDirectory("/Users/u/projects/we\\ird", { homedir: HOME })).toBe(
      "~/projects/we\\ird",
    );
  });

  it("rewrites the homedir itself as '~' when either side has a trailing slash", () => {
    expect(sanitizeWorkingDirectory(`${HOME}/`, { homedir: HOME })).toBe("~");
    expect(sanitizeWorkingDirectory(HOME, { homedir: `${HOME}/` })).toBe("~");
    expect(sanitizeWorkingDirectory(`${WD}/`, { homedir: HOME })).toBe("~/projects/foo");
  });

  it("rewrites a working directory whose name begins with two dots under homedir", () => {
    expect(sanitizeWorkingDirectory("/Users/u/..\\w", { homedir: HOME })).toBe("~/..\\w");
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

  it("does not count a relative name containing a backslash as a mutation", () => {
    const result = sanitizeRelatedFiles(["back\\slash.txt"], {
      workingDirectory: WD,
      homedir: HOME,
    });
    expect(result.sanitized).toEqual(["back\\slash.txt"]);
    expect(result.mutationCount).toBe(0);
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
