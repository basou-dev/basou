import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { type CommandWorkdir, deriveCommandWorkdir } from "./command-workdir.js";

const CWD = "/Users/dev/projects/alpha";

/** A captured shell line, in the shape both importers record (`bash -c <program>`). */
function shell(script: string, cwd = CWD): CommandWorkdir {
  return deriveCommandWorkdir("bash", ["-c", script], cwd);
}

/** The reason, or the outcome kind when it was not an abstention — so a wrong PASS reads as a wrong reason. */
function reason(result: CommandWorkdir): string {
  return result.kind === "ambiguous" ? result.reason : result.kind;
}

describe("deriveCommandWorkdir — the mis-attributions this grammar exists to stop", () => {
  // Every row of the table in issue #184, verified against bash. Each was
  // credited to a directory the command did not run in; none may be now.
  it("does not credit `cd /a && cd /b` to the first cd", () => {
    expect(reason(shell("cd /a && cd /b && git commit -m x"))).toBe("multiple_cd");
  });

  it("does not credit a cd inside a command substitution", () => {
    expect(reason(shell("echo $(cd /other && pwd) && git commit -m x"))).toBe(
      "command_substitution",
    );
  });

  it("does not credit a cd inside a subshell", () => {
    expect(reason(shell("(cd /other && true) && git commit -m x"))).toBe("subshell");
  });

  it("does not credit a cd written inside an escaped quote in a commit message", () => {
    expect(reason(shell('git commit -m "say \\"x; cd /other && y\\""'))).toBe("backslash_escape");
  });

  it("does not credit a cd that a comment has commented out", () => {
    expect(reason(shell("git commit -m x # ; cd /other && ignored"))).toBe("comment");
  });

  it("does not read a backslash-escaped target as if the space split it", () => {
    // bash goes to `/p with space`; the old regex stopped at the backslash and
    // credited cwd. Abstaining is the honest answer until the grammar covers it.
    expect(reason(shell("cd /p\\ with\\ space && git commit -m x"))).toBe("backslash_escape");
  });

  it("follows a cd separated by `;` instead of `&&`", () => {
    // Previously credited to cwd: the old regex required `&&`.
    expect(shell("cd /other; git commit -m x")).toEqual({ kind: "target", path: "/other" });
  });

  it("follows `cd -- <path>`", () => {
    expect(shell("cd -- /other && git commit -m x")).toEqual({ kind: "target", path: "/other" });
    // `--` is the shell saying the next word is not an option; a leading `-`
    // after it is part of the directory name.
    expect(shell("cd -- -weird && git commit -m x")).toEqual({
      kind: "target",
      path: `${CWD}/-weird`,
    });
  });

  it("does not credit cwd when the work ran through `sh -c`", () => {
    expect(reason(shell("sh -c 'cd /other && git commit -m x'"))).toBe("indirect_execution");
  });

  it("does not credit cwd when the work ran through `env -C`", () => {
    expect(reason(shell("env -C /other git commit -m x"))).toBe("indirect_execution");
  });
});

describe("deriveCommandWorkdir — the two shapes carried over from #183", () => {
  it("resolves a relative cd against cwd, so two sessions do not share one key", () => {
    // The same spelling beside two different repositories is two directories.
    expect(shell("cd ../beta && git commit -m x", "/Users/dev/projects/alpha")).toEqual({
      kind: "target",
      path: "/Users/dev/projects/beta",
    });
    expect(shell("cd ../beta && git commit -m x", "/Users/dev/work/alpha")).toEqual({
      kind: "target",
      path: "/Users/dev/work/beta",
    });
  });

  it("refuses an unexpanded variable anywhere in the target, not only in its last segment", () => {
    expect(reason(shell("cd $ROOT/app && git commit -m x"))).toBe("unexpanded_variable");
    expect(reason(shell("cd /srv/$NAME && git commit -m x"))).toBe("unexpanded_variable");
    expect(reason(shell('cd "$SMOKE_DIR" && git commit -m x'))).toBe("unexpanded_variable");
  });
});

describe("deriveCommandWorkdir — what the grammar accepts", () => {
  it("reads the dominant shape", () => {
    expect(shell("cd /repos/beta && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("says cwd when nothing moved", () => {
    expect(shell("git commit -m x")).toEqual({ kind: "cwd" });
  });

  it("says cwd across a pipeline that holds no cd", () => {
    expect(shell("git diff --stat | head -50")).toEqual({ kind: "cwd" });
  });

  it("reads a cd on its own line, with the work on the lines after it", () => {
    expect(shell("cd /repos/beta\ngit add .\ngit commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("expands an unquoted leading tilde", () => {
    expect(shell("cd ~/projects/beta && git commit -m x")).toEqual({
      kind: "target",
      path: `${homedir()}/projects/beta`,
    });
    expect(shell("cd ~ && git commit -m x")).toEqual({ kind: "target", path: homedir() });
  });

  it("reads a quoted target, keeping the space inside it", () => {
    expect(shell('cd "/repos/my beta" && git commit -m x')).toEqual({
      kind: "target",
      path: "/repos/my beta",
    });
    expect(shell("cd '/repos/my beta' && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/my beta",
    });
  });

  it("does not count a redirection as a second operand", () => {
    expect(shell("cd /repos/beta 2>&1; git add .")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell("cd /repos/beta > /dev/null && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell("cd /repos/beta &>/dev/null && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("skips the assignments in front of a command", () => {
    expect(shell("cd /repos/beta && LC_ALL=C git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    // The cd is still the command when an assignment precedes it.
    expect(shell("FOO=1 cd /other && git commit -m x")).toEqual({
      kind: "target",
      path: "/other",
    });
  });

  it("sees a program that assignments are standing in front of", () => {
    // `sudo` must not become invisible because `LC_ALL=C` is the first word.
    expect(reason(shell("cd /repos/beta && LC_ALL=C sudo git commit -m x"))).toBe(
      "indirect_execution",
    );
  });

  it("keeps `#` inside a word as part of that word", () => {
    expect(shell("git log --grep=fix#12 --oneline")).toEqual({ kind: "cwd" });
  });

  it("keeps a cd first when only blanks and assignments precede it", () => {
    // A leading newline, a doubled separator and a bare assignment are not
    // commands, so none of them means "something already ran somewhere else".
    expect(shell("\ncd /repos/beta && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell(";cd /repos/beta && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell("SP=/tmp/scratch\ncd /repos/beta\ngit commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("still sees a pipeline around a cd that blanks pushed off index 0", () => {
    // The `cd` is the first COMMAND but the second segment; the pipeline check
    // must follow it rather than look at a fixed position.
    expect(reason(shell("\ncd /other | cat"))).toBe("cd_in_pipeline");
  });

  it("strips a trailing separator without inventing an empty command", () => {
    expect(shell("cd /repos/beta && git commit -m x;")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });
});

describe("deriveCommandWorkdir — one refusal per rule", () => {
  const cases: [string, string, string][] = [
    ["command_substitution", "$(…) anywhere", "git commit -m $(date)"],
    ["command_substitution", "$(…) inside double quotes", 'git commit -m "at $(date)"'],
    ["backtick", "a backtick substitution", "git commit -m `date`"],
    ["backtick", "a backtick inside double quotes", 'git commit -m "at `date`"'],
    ["backslash_escape", "a backslash inside double quotes", 'git commit -m "a\\b"'],
    ["subshell", "an opening paren", "( git commit -m x )"],
    ["subshell", "a stray closing paren", "git commit -m x )"],
    ["heredoc", "a heredoc", "git commit -F - <<'EOF'\nmessage\nEOF"],
    ["heredoc", "a here-string", "git commit -F - <<< message"],
    ["backslash_escape", "a backslash outside quotes", "git add a\\ b"],
    ["comment", "a comment at the start of a word", "git commit -m x # done"],
    ["comment", "a full-line comment", "# nothing to do\ngit commit -m x"],
    ["or_operator", "`||`", "cd /other || true"],
    ["background", "a background job", "sleep 1 & git commit -m x"],
    ["background", "a background job with no spaces", "sleep 1& git commit -m x"],
    ["unterminated_quote", "an unclosed double quote", 'git commit -m "x'],
    ["unterminated_quote", "an unclosed single quote", "git commit -m 'x"],
    ["multiple_cd", "two cds", "cd /a && cd /b"],
    ["cd_not_first", "a cd after the first command", "git fetch && cd /other && git commit -m x"],
    ["cd_in_pipeline", "a cd in a pipeline", "cd /other | cat"],
    ["unsupported_cd_form", "a bare cd (to $HOME)", "cd && git commit -m x"],
    ["unsupported_cd_form", "`cd -` (to $OLDPWD)", "cd - && git commit -m x"],
    ["unsupported_cd_form", "a cd option", "cd -P /other && git commit -m x"],
    ["unsupported_cd_form", "two operands", "cd /a /b && git commit -m x"],
    ["unsupported_cd_form", "an empty target", 'cd "" && git commit -m x'],
    ["unexpanded_variable", "an unexpanded variable", "cd $ROOT && git commit -m x"],
    ["glob", "a glob", "cd /repos/* && git commit -m x"],
    ["tilde_user", "another account's home", "cd ~alice/app && git commit -m x"],
    ["quoted_tilde", "a quoted tilde, which bash does not expand", 'cd "~/app" && git commit -m x'],
    ["directory_stack", "pushd", "pushd /other && git commit -m x"],
    ["directory_stack", "popd", "popd && git commit -m x"],
    ["indirect_execution", "xargs", "echo x | xargs git commit -m"],
    ["indirect_execution", "timeout", "timeout 60 git commit -m x"],
    ["indirect_execution", "sudo", "sudo git commit -m x"],
    ["chdir_option", "`git -C`", "git -C /other commit -m x"],
    ["chdir_option", "`git --git-dir=`", "git --git-dir=/other/.git commit -m x"],
    // git accepts a short option fused to its value, and so must this.
    ["chdir_option", "`git -C` with no separator", "git -C/other commit -m x"],
    ["chdir_option", "`make -C`", "make -C /other build"],
  ];
  for (const [expected, what, script] of cases) {
    it(`refuses ${what} with \`${expected}\``, () => {
      expect(reason(shell(script))).toBe(expected);
    });
  }

  it("refuses a relative cd when cwd itself is not absolute", () => {
    expect(reason(shell("cd ../beta && git commit -m x", "projects/alpha"))).toBe(
      "unresolvable_relative",
    );
  });
});

describe("deriveCommandWorkdir — invocations that are not a shell program", () => {
  it("does not read another program's `-c` as a shell program", () => {
    // A real captured shape: `codex -c <config>`. Reading it as shell text would
    // be reading someone else's argument.
    expect(deriveCommandWorkdir("codex", ["-c", "cd /other && git commit"], CWD)).toEqual({
      kind: "cwd",
    });
  });

  it("says cwd for a direct exec", () => {
    expect(deriveCommandWorkdir("git", ["log", "--oneline", "-5"], CWD)).toEqual({ kind: "cwd" });
  });

  it("refuses a direct exec that relocates its own work", () => {
    expect(reason(deriveCommandWorkdir("git", ["-C", "/other", "log"], CWD))).toBe("chdir_option");
    expect(reason(deriveCommandWorkdir("env", ["-C", "/other", "git", "log"], CWD))).toBe(
      "indirect_execution",
    );
  });

  it("refuses a shell invocation it does not read", () => {
    expect(reason(deriveCommandWorkdir("bash", ["script.sh"], CWD))).toBe("unsupported_invocation");
    expect(reason(deriveCommandWorkdir("bash", ["-lc", "git commit -m x"], CWD))).toBe(
      "unsupported_invocation",
    );
    expect(reason(deriveCommandWorkdir("bash", [], CWD))).toBe("unsupported_invocation");
  });

  it("reads a shell named by its path", () => {
    expect(deriveCommandWorkdir("/bin/sh", ["-c", "cd /other && git commit -m x"], CWD)).toEqual({
      kind: "target",
      path: "/other",
    });
  });
});

describe("deriveCommandWorkdir — quoting decides what is an operator", () => {
  it("does not treat a quoted separator as a separator", () => {
    // `;` and `&&` inside a commit message are message text, not shell syntax.
    expect(shell('cd /repos/beta && git commit -m "fix; cd /other && oops"')).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell("git commit -m 'fix; cd /other'")).toEqual({ kind: "cwd" });
  });

  it("does not treat a quoted `#` as a comment", () => {
    expect(shell('git commit -m "fix # 12"')).toEqual({ kind: "cwd" });
  });

  it("does not treat a quoted glob as a glob", () => {
    expect(shell('cd "/repos/*" && git commit -m x')).toEqual({
      kind: "target",
      path: "/repos/*",
    });
  });

  it("does not treat a quoted `--` as the `cd --` marker", () => {
    expect(reason(shell("cd '--' /other && git commit -m x"))).toBe("unsupported_cd_form");
  });

  it("joins quoted and unquoted parts of one word", () => {
    expect(shell('cd /repos"/beta" && git commit -m x')).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("does not treat a quoted redirection as a redirection", () => {
    expect(shell("cd '>' && git commit -m x")).toEqual({ kind: "target", path: `${CWD}/>` });
  });
});
