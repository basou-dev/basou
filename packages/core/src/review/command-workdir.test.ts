import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { type CommandWorkdir, deriveCommandWorkdir } from "./command-workdir.js";

const CWD = "/Users/u/projects/alpha";

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
    expect(shell("cd ../beta && git commit -m x", "/Users/u/projects/alpha")).toEqual({
      kind: "target",
      path: "/Users/u/projects/beta",
    });
    expect(shell("cd ../beta && git commit -m x", "/Users/u/work/alpha")).toEqual({
      kind: "target",
      path: "/Users/u/work/beta",
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
    expect(shell("cd /repos/beta >> /dev/null && git commit -m x")).toEqual({
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

  it("keeps a cd first when only blank lines and assignments precede it", () => {
    // A blank line and a bare assignment are not commands, so neither means
    // "something already ran somewhere else". (A leading `;` is NOT this case:
    // bash rejects the whole program, which is covered under `shell_syntax`.)
    expect(shell("\ncd /repos/beta && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell("SP=/tmp/scratch\ncd /repos/beta\ngit commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("still sees the pipeline around a cd that is not the first segment", () => {
    // The `cd` is the first COMMAND but the second segment, because an
    // assignment-only segment precedes it. The pipeline check must follow the
    // cd rather than look at a fixed position.
    expect(reason(shell("FOO=1; cd /other | cat"))).toBe("cd_in_pipeline");
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
    ["glob", "a brace expansion", "cd /repos/{alpha,beta} && git commit -m x"],
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
    // GNU make reads `-sC /other` as `-s` clustered with `-C /other`.
    ["chdir_option", "a clustered `make -sC`", "make -sC /other build"],
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

/**
 * Every case here is one where the grammar used to answer `cwd` or `target`
 * with confidence and bash disagreed. They are grouped because they share a
 * failure shape rather than a rule: the grammar treated something it had not
 * modelled as if it were harmless.
 */
describe("deriveCommandWorkdir — shapes that must not reach a confident answer", () => {
  it("does not read a redirection as part of the cd target", () => {
    // `cd /tmp>/dev/null` is `cd /tmp` with stdout redirected, not a cd to a
    // directory whose name contains `>`.
    expect(shell("cd /repos/beta>/dev/null && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    // A redirection may also sit between the command and its operand.
    expect(shell("cd>/dev/null /repos/beta && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    // A quoted redirection TARGET is still a target, not a second operand.
    expect(shell('cd /repos/beta >"/dev/null" && git commit -m x')).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    // `>|` is one redirection operator; its `|` starts no pipeline.
    expect(shell("cd /repos/beta >| /dev/null && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("refuses a redirection whose target may not be one word", () => {
    // Whether the shell could open the target decides whether the command ran at
    // all, and a command that did not run has no directory. `2>&foo` is a bad
    // descriptor in bash, dash and ksh, which run nothing, while zsh reads the
    // word as a file and runs the `cd`.
    expect(reason(shell("cd /repos/beta 2>&foo && git commit -m x"))).toBe(
      "unreadable_redirection",
    );
    // A descriptor move: measured, dash rejects `2>&1-` and runs nothing while
    // bash, zsh and ksh perform the move and run the `cd`.
    expect(reason(shell("cd /repos/beta 2>&1- && git commit -m x"))).toBe("unreadable_redirection");
    // Closing a descriptor is refused even though all four shells accept it,
    // because a close changes what a LATER redirection does and this grammar
    // reads each one independently. Measured, `1>&- 2>&1 && touch RAN` creates
    // nothing in any of the four: the second redirection duplicates the
    // descriptor the first closed, and the command after `&&` never runs. The
    // close itself is the readable half; accepting it and not the consequence is
    // what answered `cwd` here.
    expect(reason(shell("1>&- 2>&1 && git commit -m x"))).toBe("unreadable_redirection");
    expect(reason(shell("cd /repos/beta 2>&- && git commit -m x"))).toBe("unreadable_redirection");
    // An unquoted glob or expansion may become several words or none, and that is
    // where the shells part company: with two files matching `log.*`, bash calls
    // it an ambiguous redirect and runs nothing, zsh writes to both, and dash and
    // ksh do not glob a redirection target at all and create the literal name.
    expect(reason(shell("cd /repos/beta > log.* && git commit -m x"))).toBe(
      "unreadable_redirection",
    );
    expect(reason(shell("cd /repos/beta > $OUT && git commit -m x"))).toBe(
      "unreadable_redirection",
    );
    // `> ""` names no file, and every shell measured runs nothing.
    expect(reason(shell('cd /repos/beta > "" && git commit -m x'))).toBe("unreadable_redirection");
    // What stays readable: a plain descriptor, and a QUOTED expansion, which is
    // one word whatever it holds. Whether that file could then be opened is a
    // fact about the filesystem, which this grammar never claimed to read — with
    // or without an expansion in the way.
    expect(shell("cd /repos/beta 2>&1 && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell('cd /repos/beta > "$SP/build.log" 2>&1 && git commit -m x')).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("refuses `&>`, which is a redirection in two shells and a background job in two", () => {
    // bash and zsh read `&>file` as redirecting both streams. dash and ksh read
    // the `&` as backgrounding the command and the `>` as redirecting what
    // follows — and a backgrounded `cd` runs in a subshell, so its directory dies
    // with it and everything after the `&&` runs in cwd. Measured with
    // `cd /x &>/dev/null && touch RAN`: the file lands in /x under bash and zsh
    // and in cwd under dash and ksh. This used to answer `target /x` for all
    // four, which is a wrong repository for half of them.
    expect(reason(shell("cd /repos/beta &>/dev/null && git commit -m x"))).toBe("background");
    // `&>>` splits the same way, and additionally splits bash 3.2 from bash 4.
    expect(reason(shell("cd /repos/beta &>>/dev/null && git commit -m x"))).toBe("background");
  });

  it("does not read a quoted NAME as an assignment", () => {
    // bash only sees `FOO=x` as an assignment when the name is unquoted;
    // `"FOO"=x` is a command name, so what follows it are its arguments and no
    // `cd` runs at all. That much is settled — the point is that the `cd` is
    // NOT the command. Which directory to name is then a second question, and
    // the answer is none: `FOO=x` is not a program name this grammar reads, so
    // it reaches the floor. (bash agrees it is not one — `command not found`,
    // after which the `&&` means the commit never ran either, so the `cwd` this
    // once returned was a confident answer about a command that did not run.)
    expect(reason(shell('"FOO"=x cd /other && git commit -m y'))).toBe("unrecognized_command_word");
  });

  it("applies quoting per character, not per word", () => {
    // The `?` is unquoted even though the word contains quotes, so the shell
    // globbed it and what it became is not in the text. The quoted part has to
    // carry characters of its own — an empty `""` leaves the mask all-unquoted
    // and would pass whether the mask is read per character or per word.
    expect(reason(shell('cd /repos/bet?"a" && git commit -m x'))).toBe("glob");
    expect(reason(shell('cd /repos/bet?"" && git commit -m x'))).toBe("glob");
    // The NAME of an assignment is unquoted even though its value is not, so
    // this is an assignment prefix and the `cd` behind it is the command.
    expect(shell('FOO="x" cd /repos/beta && git commit -m x')).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    // A `$` inside single quotes is literal, so it disqualifies nothing.
    expect(shell("cd '/repos/$literal' && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/$literal",
    });
  });

  it("refuses a compound command instead of assuming its cd did not run", () => {
    for (const script of [
      "if cd /other; then git commit -m x; fi",
      "time cd /other",
      "while cd /other; do git commit -m x; done",
      "{ cd /other; git commit -m x; }",
      "! cd /other",
    ]) {
      expect(reason(shell(script))).toBe("compound_command");
    }
  });

  it("refuses a cd reached through `command` or `builtin`", () => {
    // `command cd /other` moves the shell exactly as a bare `cd` does.
    expect(reason(shell("command cd /other && git commit -m x"))).toBe("indirect_execution");
    expect(reason(shell("builtin cd /other && git commit -m x"))).toBe("indirect_execution");
  });

  it("refuses `$'…'`, whose value is not its text", () => {
    expect(reason(shell("$'cd' /other && git commit -m x"))).toBe("dollar_quote");
    expect(reason(shell('$"cd" /other && git commit -m x'))).toBe("dollar_quote");
  });

  it("refuses an assignment to the shell state that cd itself reads", () => {
    // bash goes to /tmp here; this process's `HOME` is a different machine's.
    expect(reason(shell("HOME=/tmp\ncd ~ && git commit -m x"))).toBe("shell_state_assignment");
    // With CDPATH set, a relative `cd` does not resolve against cwd at all.
    expect(reason(shell("CDPATH=/ cd repos && git commit -m x"))).toBe("shell_state_assignment");
    expect(reason(shell("OLDPWD=/tmp\ncd /other && git commit -m x"))).toBe(
      "shell_state_assignment",
    );
    // An unrelated assignment is still just an assignment.
    expect(shell("LC_ALL=C cd /repos/beta && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("refuses an assignment whose value it cannot read", () => {
    // The rule above looks at the NAME being assigned; an expansion in the VALUE
    // can assign to a second variable it never sees. With `CDPATH` unset,
    // `A=${CDPATH:=<dir>}` sets it, and the `cd repos` after it stops resolving
    // against cwd at all: measured, bash, zsh and dash all land under the new
    // CDPATH rather than under cwd. (ksh was measured doing both, depending on
    // the target — which is itself a reason not to answer.) The grammar answered
    // `<cwd>/repos`.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, which is the subject of the test
    expect(reason(shell("A=${CDPATH:=/}\ncd repos && git commit -m x"))).toBe(
      "unreadable_assignment_value",
    );
    // The same value as a prefix rather than a segment of its own. A segment that
    // is nothing but assignments is why the floor cannot cover this: such a
    // segment reaches no word in command position at all.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, which is the subject of the test
    expect(reason(shell("A=${CDPATH:=/} :\ncd repos && git commit -m x"))).toBe(
      "unreadable_assignment_value",
    );
    // A literal value is still read, and so is a `$` the shell does not expand.
    expect(shell("SP=/tmp/scratch\ncd /repos/beta && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell("A='$HOME' cd /repos/beta && git commit -m x")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    // The accepted cost: a value that only READS a variable is refused too,
    // because telling the two apart means enumerating the expansions that assign
    // — `${V=…}`, `${V:=…}`, and whatever a later shell adds — which is the
    // enumeration this grammar exists to stop depending on. Measured on the
    // corpus this was built against: four events, none carrying a `git commit`.
    expect(reason(shell("cd /repos/beta && pnpm test; rc=$?; echo done"))).toBe(
      "unreadable_assignment_value",
    );
  });

  it("refuses a `~user` in an assignment value, which stops zsh before the cd", () => {
    // Measured: `A=~nosuchuser cd /x && touch RAN` creates nothing in zsh, which
    // aborts with "no such user or named directory", while bash, dash and ksh
    // assign the text literally and run the `cd`. The grammar answered
    // `target /x` for all four, zsh included.
    expect(reason(shell("A=~nosuchuser_9x cd /other && git commit -m y"))).toBe("tilde_user");
    // Only that form fails. `~` and `~/…` resolve in every shell, so they stay
    // readable and the refusal matches the one `cd` already applies to its own
    // operand.
    expect(shell("A=~/bin cd /other && git commit -m y")).toEqual({
      kind: "target",
      path: "/other",
    });
    expect(shell("A=~ cd /other && git commit -m y")).toEqual({
      kind: "target",
      path: "/other",
    });
  });

  it("refuses a carriage return rather than reading it as a line ending", () => {
    // bash makes `\r` part of the operand, so the cd fails and the commit runs
    // in cwd — the opposite of what the line looks like.
    expect(reason(shell("cd /other\r\ngit commit -m x"))).toBe("carriage_return");
  });

  it("refuses a program bash would not run at all", () => {
    for (const script of [
      ";cd /other && git commit -m x", // nothing to the left of `;`
      "&& cd /other", // nothing to the left of `&&`
      "cd /other &&", // nothing to the right of `&&`
      "cd /other |", // nothing to the right of `|`
      "cd /other ;; git commit -m x", // `;;` outside a case
      "cd /other >", // a redirection with no target
    ]) {
      expect(reason(shell(script))).toBe("shell_syntax");
    }
    // A trailing `;` is not the same thing: bash accepts it.
    expect(shell("cd /repos/beta && git commit -m x;")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
  });

  it("does not let a zero-width quote hide that a word was quoted", () => {
    // `FOO""=x` is not an assignment and `2''>` is not an fd prefix: bash keeps
    // the lexical fact that the word was quoted even though the quotes carry no
    // characters. Both used to leave a `cd` looking like the command.
    //
    // `FOO""=x` then reaches the floor, because `FOO=x` is not a program name
    // this grammar reads. Here that costs a correct answer — the `;` lets the
    // commit run, and it ran in cwd — which is the price of the floor not
    // knowing that bash would have failed to find the command. Measured across
    // the corpus this was built against, that price came to zero events.
    expect(reason(shell('FOO""=x cd /other; git commit -m y'))).toBe("unrecognized_command_word");
    expect(shell("2''>/dev/null cd /other; git commit -m y")).toEqual({ kind: "cwd" });
    // The quoting has to be in the NAME to matter — a quoted VALUE is fine.
    expect(shell('FOO=""x cd /other && git commit -m y')).toEqual({
      kind: "target",
      path: "/other",
    });
  });

  it("refuses a command-position word that might be an assignment prefix", () => {
    // Either the word is a prefix, and the `cd` after it moved the segment, or
    // it is the command, and nothing moved. Which one is a property of the
    // shell, and the shell is not knowable here: the importers write `bash` for
    // every captured command without observing it. Measured out of band on one
    // host — bash and ksh run the command behind both forms, dash finds neither
    // word, zsh takes `A[1]=` but rejects `A[0]=` — and NOT re-verified by this
    // test, which exercises the grammar only.
    expect(reason(shell("A[0]=x cd /other && git commit -m y"))).toBe("assignment_or_command");
    expect(reason(shell("A+=x cd /other && git commit -m y"))).toBe("assignment_or_command");

    // Only the start of the shape is matched, so a subscript this grammar
    // cannot parse does not slip through as an ordinary command. Reading these
    // as commands answered `cwd` while bash, zsh and ksh all ran the `cd`.
    expect(reason(shell("A[1+A[0]]=x cd /other && git commit -m y"))).toBe("assignment_or_command");
    expect(reason(shell("A[1 + 1]=x cd /other && git commit -m y"))).toBe("assignment_or_command");

    // The same refusal covers two shapes no shell reads as an assignment: a
    // malformed one, and a pathname expansion landing in command position.
    // What ran is equally unreadable in both. (`c[d]` is a glob over the
    // CURRENT DIRECTORY, not over PATH: it becomes `cd` only when run from a
    // directory that holds a file named `cd`, such as /usr/bin.)
    expect(reason(shell("A[[0]=x cd /other && git commit -m y"))).toBe("assignment_or_command");
    expect(reason(shell("c[d] /other && git commit -m y"))).toBe("assignment_or_command");

    // The portable `NAME=` form is a prefix in every shell here, so it keeps
    // its answer and the abstention stays narrow.
    expect(shell("A=x cd /other && git commit -m y")).toEqual({ kind: "target", path: "/other" });
    expect(reason(shell("FOO=1 A[0]=x cd /other && git commit -m y"))).toBe(
      "assignment_or_command",
    );
  });

  it("refuses a command word it cannot positively recognise", () => {
    // The floor under every other rule here. What reaches it is whatever the
    // named rules did not think of — and each review round has found another
    // such shape, every one of them previously answered confidently and wrong.
    //
    // A non-ASCII assignment name is one: zsh and ksh run the `cd` behind
    // `é[1]=x` and behind the portable `é=x`, while the name patterns above
    // match ASCII only. Neither is caught by a rule that names it; both are
    // caught by not being a program name.
    expect(reason(shell("é[1]=x cd /other && git commit -m y"))).toBe("unrecognized_command_word");
    expect(reason(shell("é=x cd /other && git commit -m y"))).toBe("unrecognized_command_word");

    // `[` is the test builtin and cannot move the shell, so refusing it costs
    // reach and buys nothing — but it is refused anyway, because admitting it
    // means keeping a list of the builtins that are safe, which is the kind of
    // list this floor exists to stop depending on. Measured cost on the corpus
    // this was built against: zero.
    expect(reason(shell("cd /other && [ -f x ] && git commit -m y"))).toBe(
      "unrecognized_command_word",
    );

    // A quoted NAME is not an assignment in any shell, so it is an ordinary
    // command word — and the floor still asks whether it is a program name.
    expect(reason(shell('"A"[0]=x cd /other && git commit -m y'))).toBe(
      "unrecognized_command_word",
    );

    // The floor must not swallow the shapes the grammar does read: a bare
    // program, a path to one, and a `cd` with a literal target.
    expect(shell("cd /repos/beta && node_modules/.bin/biome check .")).toEqual({
      kind: "target",
      path: "/repos/beta",
    });
    expect(shell("~/bin/tool --flag")).toEqual({ kind: "cwd" });
    expect(shell("./script.sh && git commit -m y")).toEqual({ kind: "cwd" });
    expect(shell("/usr/bin/true && git commit -m y")).toEqual({ kind: "cwd" });

    // An alias rewrites what a later command word means, so a line that reads
    // as inert can still have moved: `alias Y='cd /other'; Y` does.
    expect(reason(shell("alias Y='cd /other'\nY && git commit -m y"))).toBe("indirect_execution");
  });

  it("refuses a command word that names a directory", () => {
    // A trailing `/`, and a last segment of `.` or `..`, name a directory by
    // spelling alone, and no shell will execute a directory: measured in bash,
    // zsh, dash and ksh, all four run nothing, so the `&&` after it never
    // happens. Each of these answered `cwd` — a confident answer about work that
    // did not take place.
    for (const script of [
      "/usr/ && git commit -m x",
      "../ && git commit -m x",
      ".. && git commit -m x",
      "bin/. && git commit -m x",
    ]) {
      expect(reason(shell(script))).toBe("unrecognized_command_word");
    }
    // A bare `.` is the `source` builtin rather than a path, so it keeps the more
    // precise reason of the two.
    expect(reason(shell(". ./env.sh && git commit -m x"))).toBe("indirect_execution");
    // Where reading spelling alone stops: whether a path WITHOUT a trailing slash
    // is a directory is a fact about the filesystem. `/usr && git commit` runs
    // nothing in any of the four shells, and this still answers cwd for it.
    expect(shell("/usr && git commit -m x")).toEqual({ kind: "cwd" });
  });

  it("refuses an expansion in command position", () => {
    // `CMD=cd; $CMD /other` runs the cd builtin; what a command word expands to
    // is not in the text.
    expect(reason(shell("CMD=cd; $CMD /other && git commit -m y"))).toBe("unexpanded_variable");
    // …and an expansion among the operands of a program that HAS a chdir option
    // may be hiding one.
    expect(reason(shell("git $OPTS commit -m y"))).toBe("unexpanded_variable");
    // A QUOTED expansion stays one word, so it cannot split into `-C <path>`;
    // `git commit -m "$MSG"` must stay readable.
    expect(shell('git commit -m "$MSG"')).toEqual({ kind: "cwd" });
    // An expansion in the operands of a program with no chdir option at all.
    expect(shell("echo $HOME")).toEqual({ kind: "cwd" });
  });

  it("refuses an assignment that points a program at another repository", () => {
    // No `cd` and no recognised option: `GIT_DIR` alone relocates the commit.
    expect(reason(shell("GIT_DIR=/other/.git git commit -m y"))).toBe("shell_state_assignment");
    expect(reason(shell("GIT_WORK_TREE=/other git commit -m y"))).toBe("shell_state_assignment");
  });

  it("refuses `trap`, which schedules a cd to run later", () => {
    // The `cd` looks like inert quoted text, but the DEBUG trap runs it before
    // every later command.
    expect(reason(shell("trap 'cd /other' DEBUG; git commit -m y"))).toBe("indirect_execution");
  });

  it("refuses a package manager that relocates its child", () => {
    // `pnpm -C <repo> exec git commit` commits in <repo>; the captured cwd is
    // wherever pnpm was invoked from.
    expect(reason(shell("pnpm -C /other exec git commit -m x"))).toBe("chdir_option");
    expect(
      reason(deriveCommandWorkdir("pnpm", ["-C", "/other", "exec", "git", "commit"], CWD)),
    ).toBe("chdir_option");
    expect(reason(shell("npm --prefix /other run release"))).toBe("chdir_option");
    expect(reason(shell("yarn --cwd /other build"))).toBe("chdir_option");
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

  it("applies the floor to a direct exec too", () => {
    // There is no shell here to read a `cd`, but the executable still has to be
    // a program name. `../` is a directory: all four shells exit 126 on it and
    // nothing runs, while `review-gaps` sees the `git commit` in the args and
    // would credit it to cwd. The floor was previously only reached through the
    // shell path, so this shape walked straight past it.
    expect(reason(deriveCommandWorkdir("../", ["git", "commit"], CWD))).toBe(
      "unrecognized_command_word",
    );
    expect(reason(deriveCommandWorkdir("FOO=x", ["git", "commit"], CWD))).toBe(
      "unrecognized_command_word",
    );
    // A real captured executable still answers: a bare name, and a path to one.
    expect(deriveCommandWorkdir("/opt/homebrew/bin/pnpm", ["build"], CWD)).toEqual({ kind: "cwd" });
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

  it("still reads `--` and `-C` after the shell has removed their quotes", () => {
    // Quoting hides an operator from the SHELL, never from the program the
    // shell then hands the word to: `cd '--' /x` reaches cd as `cd -- /x`, and
    // `git "-C" /x` reaches git as `git -C /x`.
    expect(shell("cd '--' /other && git commit -m x")).toEqual({
      kind: "target",
      path: "/other",
    });
    expect(reason(shell('git "-C" /other commit -m x'))).toBe("chdir_option");
    // …and `cd "-"` is `cd -`, which goes to $OLDPWD, not to a directory named `-`.
    expect(reason(shell('cd "-" && git commit -m x'))).toBe("unsupported_cd_form");
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

describe("an unobserved executor and an unknown cwd (the fields the format freeze made nullable)", () => {
  // `command: null` is what an imported command now carries: the source log
  // records the shell LINE, never what ran it (#191). The whole point of the
  // change is that this must not cost the answer, because it is the shape 99.7%
  // of the captured store is in.
  it("reads a null-executor `-c` line exactly as it read `bash -c`", () => {
    for (const script of [
      "cd /other && git commit -m x",
      "git commit -m x",
      "cd ../beta && git commit -m x",
      "cd $DIR && git commit -m x",
      "(cd /other && git commit -m x)",
      "cd /a && cd /b && git commit -m x",
    ]) {
      expect(deriveCommandWorkdir(null, ["-c", script], CWD)).toEqual(
        deriveCommandWorkdir("bash", ["-c", script], CWD),
      );
    }
  });

  it("refuses a null-executor argv that is not a `-c` shell line", () => {
    // With no executor there is nothing to recognise as a program, so a plain
    // argv cannot be placed at all — it must not fall through to `cwd` the way a
    // recognised direct exec does.
    expect(reason(deriveCommandWorkdir(null, ["git", "commit", "-m", "x"], CWD))).toBe(
      "unsupported_invocation",
    );
    expect(reason(deriveCommandWorkdir(null, [], CWD))).toBe("unsupported_invocation");
    expect(reason(deriveCommandWorkdir(null, ["-lc", "git commit -m x"], CWD))).toBe(
      "unsupported_invocation",
    );
    // `-c` with anything other than exactly one operand is not the shape either.
    expect(reason(deriveCommandWorkdir(null, ["-c"], CWD))).toBe("unsupported_invocation");
    expect(reason(deriveCommandWorkdir(null, ["-c", "git log", "extra"], CWD))).toBe(
      "unsupported_invocation",
    );
  });

  it("abstains on a relative `cd` when the cwd was never recorded", () => {
    // An unknown cwd is nothing to resolve against — the same position a
    // relative cwd was already in, and for the same reason.
    expect(reason(deriveCommandWorkdir(null, ["-c", "cd ../beta && git commit -m x"], null))).toBe(
      "unresolvable_relative",
    );
    expect(reason(deriveCommandWorkdir(null, ["-c", "cd beta && git commit -m x"], null))).toBe(
      "unresolvable_relative",
    );
  });

  it("still answers an ABSOLUTE `cd` when the cwd was never recorded", () => {
    // The target does not depend on where the shell started, so an unknown cwd
    // costs nothing here. Losing this would throw away readable evidence.
    expect(deriveCommandWorkdir(null, ["-c", "cd /other && git commit -m x"], null)).toEqual({
      kind: "target",
      path: "/other",
    });
  });

  it("reports a line that did not move the shell as `cwd` even when the cwd is unknown", () => {
    // `kind: "cwd"` is a statement about the LINE (nothing moved), not a claim
    // that the directory is known. The caller is what must abstain, and
    // review-gaps does: it has no path to credit.
    expect(deriveCommandWorkdir(null, ["-c", "git commit -m x"], null)).toEqual({ kind: "cwd" });
  });

  it("does not read a `-c` flag on a program that is not a shell", () => {
    // The reason the executor is still consulted when it IS recorded: `-c` is a
    // config flag elsewhere, and reading that string as a shell program would be
    // reading someone else's text. `codex -c <config>` is a real captured shape,
    // and the `cd` inside its config moved nothing — so the answer is the
    // session's directory, NOT `/other`.
    expect(deriveCommandWorkdir("codex", ["-c", "cd /other && git commit"], CWD)).toEqual({
      kind: "cwd",
    });
    // Which is why a null executor may only ever mean "a shell whose name was
    // not recorded": were it read as "any program", this same argv would be
    // credited to `/other`.
    expect(deriveCommandWorkdir(null, ["-c", "cd /other && git commit"], CWD)).toEqual({
      kind: "target",
      path: "/other",
    });
  });
});
