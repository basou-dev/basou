import { describe, expect, it } from "vitest";
import { toBrowserUrl } from "./repo-url.js";

describe("toBrowserUrl", () => {
  it("normalizes scp-like SSH remotes", () => {
    expect(toBrowserUrl("git@github.com:caronima/hyphart.git")).toBe(
      "https://github.com/caronima/hyphart",
    );
    expect(toBrowserUrl("git@gitlab.com:group/sub/proj.git")).toBe(
      "https://gitlab.com/group/sub/proj",
    );
  });

  it("normalizes ssh:// remotes, dropping userinfo and port", () => {
    expect(toBrowserUrl("ssh://git@github.com:22/org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
    expect(toBrowserUrl("ssh://git@self-hosted.internal/team/repo")).toBe(
      "https://self-hosted.internal/team/repo",
    );
  });

  it("normalizes git:// remotes", () => {
    expect(toBrowserUrl("git://github.com/org/repo.git")).toBe("https://github.com/org/repo");
  });

  it("normalizes http(s) remotes and strips a trailing .git / slash", () => {
    expect(toBrowserUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo");
    expect(toBrowserUrl("http://ghe.example.com/org/repo/")).toBe(
      "https://ghe.example.com/org/repo",
    );
    expect(toBrowserUrl("https://github.com/org/repo")).toBe("https://github.com/org/repo");
  });

  it("forces https even when the source scheme is not (no javascript: smuggling)", () => {
    // A hostile "remote" cannot produce a non-https href.
    expect(toBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(toBrowserUrl("http://host/org/repo")).toBe("https://host/org/repo");
  });

  it("returns null for un-normalizable inputs", () => {
    expect(toBrowserUrl("")).toBeNull();
    expect(toBrowserUrl("   ")).toBeNull();
    expect(toBrowserUrl("/srv/git/repo")).toBeNull(); // bare local path
    expect(toBrowserUrl("../sibling")).toBeNull();
    expect(toBrowserUrl("git@host:")).toBeNull(); // empty path
    expect(toBrowserUrl("https://github.com")).toBeNull(); // no path
  });

  it("trims surrounding whitespace", () => {
    expect(toBrowserUrl("  git@github.com:org/repo.git\n")).toBe("https://github.com/org/repo");
  });
});
