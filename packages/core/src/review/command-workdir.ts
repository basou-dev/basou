import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

/**
 * Deriving the directory a captured command ran in, from the shell text basou
 * recorded.
 *
 * This is NOT a shell parser. It is a deliberately narrow accepted grammar with
 * one property the previous regex did not have: it can say "I cannot read this".
 *
 * The asymmetry that shapes every rule here: an abstention is cheap, a WRONG
 * directory is expensive. A wrong directory credits work to a repository it
 * never touched, and in `review-gaps` that can manufacture a `candidate` — the
 * one verdict that surfacer must never reach by accident. `unknown` is already
 * an honest, visible outcome. So anything the grammar cannot read with
 * certainty is reported as ambiguous rather than guessed at, and in particular
 * never falls back to the session's cwd.
 *
 * The rule that keeps that promise honest is that the DEFAULT is not "cwd" for
 * anything unrecognised. A line reaches `cwd` only after every one of its
 * commands has been recognised as one that cannot move the shell; a construct
 * the grammar does not model (a compound command, a shell keyword, execution
 * through another program) is ambiguous, not assumed harmless.
 *
 * Widening the grammar later is safe: every shape it does not accept today is
 * reported as unread, so accepting more can only move lines out of `ambiguous`,
 * never silently change an answer that was already given.
 *
 * KNOWN ASSUMPTION, deliberately taken: whenever a `;` or a newline appears
 * anywhere after the `cd`, this reads the `cd` as having succeeded.
 *
 * `&&` alone would prove it — the later command ran, so the `cd` returned 0 —
 * but only for the commands that stay control-dependent on it. A single later
 * `;` ends that dependency: in `cd /missing && :; git commit`, bash skips the
 * `:` and runs the commit in cwd. So the assumption covers `cd X; cmd`,
 * `cd X<newline>cmd`, and `cd X && cmd; cmd` alike — only a line whose
 * separators are all `&&` is free of it.
 *
 * It is taken because the `;`/newline form is the common captured one (a
 * multi-line script whose first line is the `cd`) and because issue #184 lists
 * `cd /other; git commit` among the lines that must stop being credited to cwd.
 * Operator ruling, 2026-08-03: keep it.
 *
 * KNOWN LIMIT, and the reason none of this makes a confident answer safe: the
 * floor below reads the SHAPE of a word, not what it means. `chdir /x` moves zsh
 * and dash, `noglob cd /x` moves zsh, and `find … -execdir git commit ';'`
 * commits elsewhere in every shell — each of them an ordinary program name here,
 * each answered `cwd`. `PATH=/missing git commit` is the same class from the
 * other side: the command word is a perfectly ordinary `git`, and it is the
 * assignment in front of it that means no commit ran at all, in any shell.
 * Which names, which options and which variables are special is still an
 * enumerated list, and still one list per shell for as long as the recorded
 * executor is not observed at all (#191). See #192.
 */

/** Why the grammar refused to name a directory. One per rule, so a test cannot pass for the wrong reason. */
export type CommandWorkdirAmbiguity =
  /** The recorded invocation is not a shape this grammar reads (e.g. `bash script.sh`, `bash -lc …`). */
  | "unsupported_invocation"
  /** `$(…)`: the substitution runs elsewhere and its text is not the command's text. */
  | "command_substitution"
  /** `$'…'` / `$"…"`: quoting forms whose value is not their text. */
  | "dollar_quote"
  /** A backtick substitution, same problem as `$(…)`. */
  | "backtick"
  /** `(…)`: a subshell's `cd` does not outlive it, so the outer directory is a different question. */
  | "subshell"
  /** `<<` / `<<<`: the body is data whose lines would otherwise read as commands. */
  | "heredoc"
  /** A backslash escape: word splitting stops being readable from quoting alone. */
  | "backslash_escape"
  /** A `#` comment: what follows is not executed, and the previous regex read it as if it were. */
  | "comment"
  /** `||`: whether the left side ran, and so where the right side ran, is not decidable from text. */
  | "or_operator"
  /** A background `&`: the two sides interleave, so "the" directory is not one thing. */
  | "background"
  /** A quote that never closes: everything after it is unreadable. */
  | "unterminated_quote"
  /** A carriage return: the shell saw it as text, so the line is not the line it looks like. */
  | "carriage_return"
  /** The program is not valid shell, so reasoning about what it did is reasoning about nothing. */
  | "shell_syntax"
  /** A redirection whose target the grammar cannot read (`2>&foo`, `> *`, `> $UNSET`): whether the shell could open it decides whether the command ran at all. */
  | "unreadable_redirection"
  /** A compound command or shell keyword (`if`, `for`, `time`, `{`): control flow this grammar does not model. */
  | "compound_command"
  /** More than one `cd`: the effective directory depends on order and success. */
  | "multiple_cd"
  /** A `cd` after the first command: the commands before it ran somewhere else. */
  | "cd_not_first"
  /** The `cd` is part of a pipeline, so it ran in a subshell and changed nothing. */
  | "cd_in_pipeline"
  /** A `cd` form outside the grammar (`cd`, `cd -`, options, several operands). */
  | "unsupported_cd_form"
  /** An assignment that relocates the work (`HOME`, `CDPATH`, `GIT_DIR`, `GIT_WORK_TREE`, …). */
  | "shell_state_assignment"
  /** An assignment whose VALUE is not its text (`A=${CDPATH:=/}`): an expansion inside it can set another variable, including one that relocates the work. */
  | "unreadable_assignment_value"
  /** The target still holds an unexpanded `$`, so its text is not its value. */
  | "unexpanded_variable"
  /** The target is a glob or a brace expansion: what it became is not recoverable. */
  | "glob"
  /** `~user`: another account's home is not resolvable from here. */
  | "tilde_user"
  /** A quoted `~`, which the shell does NOT expand — reading it either way would invent a path. */
  | "quoted_tilde"
  /** A relative target with no absolute cwd to resolve it against. */
  | "unresolvable_relative"
  /** `pushd` / `popd`: the directory stack is state this grammar does not model. */
  | "directory_stack"
  /** Execution through another program (`sh -c`, `env`, `xargs`, …), which may run its child elsewhere. */
  | "indirect_execution"
  /** An explicit chdir option (`git -C`, `pnpm -C`, …), which moves the work without a `cd`. */
  | "chdir_option"
  /** A command-position word shaped like `NAME+=…` or `NAME[…`: it may be an assignment prefix, so the command may be the next word, or it may be the command itself. */
  | "assignment_or_command"
  /** A command-position word that is not a shape this grammar recognises. The floor: what is not positively read is not answered for. */
  | "unrecognized_command_word";

/**
 * Where a captured command ran. Three outcomes, because two were the bug: with
 * only "cwd" and "a path", an unreadable line had to become one of them, and it
 * became cwd.
 */
export type CommandWorkdir =
  /**
   * The line did not move the shell, and the grammar read enough of it to be
   * sure — so it ran in the session's cwd, WHATEVER that was. This says nothing
   * about the cwd being known: a captured event whose `cwd` is null still gets
   * this answer, and the caller then has a read line and no directory to name.
   */
  | { kind: "cwd" }
  /** It ran in this absolute path (`~` expanded, relative resolved against cwd). */
  | { kind: "target"; path: string }
  /** The line cannot be read with certainty. The caller must abstain, not fall back to cwd. */
  | { kind: "ambiguous"; reason: CommandWorkdirAmbiguity };

function ambiguous(reason: CommandWorkdirAmbiguity): CommandWorkdir {
  return { kind: "ambiguous", reason };
}

/** Shells whose `-c` argument is a program this grammar reads. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh"]);

/**
 * Programs that run ANOTHER program, possibly in another directory
 * (`env -C`, `sh -c 'cd …'`, `xargs`, `ssh`) or with a directory this grammar
 * cannot see. Their presence anywhere in the line makes it ambiguous: not
 * because they always chdir, but because whether they did is not readable.
 *
 * `command` and `builtin` are here because they run the `cd` builtin itself:
 * `command cd /other` moves the shell exactly as `cd /other` does. `trap` is
 * here because it SCHEDULES code — `trap 'cd /other' DEBUG` moves the shell
 * before every later command, and its `cd` looks like inert quoted text.
 * `alias` is here for the same reason from the other direction: it changes what
 * a later word in command position means, so `alias X='cd /other'; X` moves the
 * shell while every word on that line reads as inert.
 */
const INDIRECT_EXECUTORS = new Set([
  ".",
  "alias",
  "bash",
  "builtin",
  "chroot",
  "command",
  "dash",
  "doas",
  "env",
  "eval",
  "exec",
  "ksh",
  "mksh",
  "nice",
  "nohup",
  "sh",
  "source",
  "ssh",
  "stdbuf",
  "su",
  "sudo",
  "timeout",
  "trap",
  "xargs",
  "zsh",
]);

/** `pushd`/`popd` move the shell without a `cd`; the stack is not modelled. */
const DIRECTORY_STACK = new Set(["pushd", "popd"]);

/**
 * Shell keywords. A line containing one is a compound command — `if cd /x;
 * then …`, `time cd /x`, `{ cd /x; }` — whose control flow decides both whether
 * the `cd` ran and what ran after it. None of that is read here, and treating
 * the keyword as an ordinary program would quietly answer `cwd` for a line that
 * moved.
 */
const SHELL_KEYWORDS = new Set([
  "!",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
  "{",
  "}",
]);

/**
 * Variables whose assignment moves the work, either by changing where a `cd`
 * lands (`HOME`, `CDPATH`, and the state `cd -` reads) or by pointing a program
 * at another repository outright (`GIT_DIR`, `GIT_WORK_TREE`). The second kind
 * needs no `cd` and no recognised option: `GIT_DIR=/other/.git git commit`
 * commits in `/other` from anywhere.
 */
const RELOCATING_VARIABLES = new Set([
  "CDPATH",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "HOME",
  "OLDPWD",
  "PWD",
]);

/**
 * Options that relocate a specific program's work without a `cd`. Keyed by
 * program rather than matched as a bare `-C` anywhere: `grep -C 3` means
 * context lines, and abstaining on every `grep -C` would spend the abstention
 * budget on lines that are not in question.
 *
 * This is an allowlist, so it is incomplete by construction — see the module
 * note on widening. It covers the programs seen running `git` in captured work.
 */
const CHDIR_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git", new Set(["-C", "--git-dir", "--work-tree"])],
  ["make", new Set(["-C", "--directory"])],
  ["gmake", new Set(["-C", "--directory"])],
  ["env", new Set(["-C", "--chdir"])],
  ["tar", new Set(["-C", "--directory"])],
  ["pnpm", new Set(["-C", "--dir", "--workspace-root", "-w"])],
  ["npm", new Set(["-C", "--prefix"])],
  ["yarn", new Set(["--cwd"])],
  ["just", new Set(["-d", "--working-directory"])],
]);

/**
 * A token of a simple command: a word after quote removal, plus which of its
 * characters were quoted and how.
 *
 * The mask is per CHARACTER, not per word, because that is where the shell
 * draws the line. `/tm?""` is still a glob (the `?` is unquoted even though the
 * word contains quotes) and `FOO="x"` is still an assignment (the name is
 * unquoted even though the value is not). One flag for the whole word gets both
 * of those wrong in the expensive direction.
 */
type Word = {
  /** The word after quote removal. */
  text: string;
  /** One character per `text` character: `n` unquoted, `s` single-quoted, `d` double-quoted. */
  mask: string;
  /**
   * `text` offsets at which a quoted region OPENED, including empty ones.
   * `FOO""=x` is not an assignment and `2''>` is not an fd prefix, but their
   * quotes contribute no characters, so the mask alone cannot see them.
   */
  quoteOpens: readonly number[];
  /** A redirection operator (`>`, `2>&`, `&>>`, …), which is syntax rather than an operand. */
  redirection?: true;
};

/** What separated two segments. `|` is kept distinct because it puts its sides in subshells. */
type Separator = ";" | "&&" | "|" | "newline";

type ScanResult =
  | { ok: true; segments: Word[][]; separators: Separator[] }
  | { ok: false; reason: CommandWorkdirAmbiguity };

type StripResult = { ok: true; words: Word[] } | { ok: false; reason: CommandWorkdirAmbiguity };

/**
 * The directory a captured `command_executed` event ran in.
 *
 * `command` is consulted, not just `args`: an importer records shell lines as
 * `-c <program>`, but `-c` is a flag on other programs too (`codex -c <config>`
 * is a real captured shape), and reading that config string as a shell program
 * would be reading someone else's text.
 *
 * `command` may be null, which means the executor was never observed (#191).
 * That is the common case for an imported command and it does NOT cost the
 * answer: the only thing this grammar takes from the executor is the one bit
 * "is this argv a shell program", and `args` of exactly `["-c", script]` carries
 * that bit on its own — no shell writes an argv of that shape for anything else,
 * and the reading of the script below never asks which shell ran it. What the
 * unknown executor does cost is stated in the KNOWN LIMIT above: which WORDS a
 * shell treats specially is a per-shell list, and that was already true when the
 * field said `bash` without having observed it.
 *
 * `cwd` may be null for the same reason. A null cwd cannot answer "it ran in the
 * session's directory", so the two outcomes that rest on it — `kind: "cwd"` and
 * resolving a relative target — abstain instead.
 */
export function deriveCommandWorkdir(
  command: string | null,
  args: readonly string[],
  cwd: string | null,
): CommandWorkdir {
  const script = args.length === 2 && args[0] === "-c" ? args[1] : undefined;
  if (command === null) {
    // An unobserved executor with a `-c` argv is a shell line whose shell is
    // unknown; anything else is an argv this grammar cannot place at all.
    if (script === undefined) return ambiguous("unsupported_invocation");
    return readShellProgram(script, cwd);
  }
  const program = basename(command);
  if (SHELLS.has(program)) {
    if (script === undefined) return ambiguous("unsupported_invocation");
    return readShellProgram(script, cwd);
  }
  // A direct exec: there is no shell to interpret a `cd`, so the only way this
  // ran elsewhere is the program itself relocating its child. The floor still
  // applies — a word that is not a program name is not answered for here either.
  // `deriveCommandWorkdir("../", ["git", "commit"], cwd)` is the shape that
  // matters: all four shells exit 126 on it and no commit runs, while
  // `review-gaps` sees `git commit` among the args and would credit cwd.
  if (!isPlainCommandHead(command)) return ambiguous("unrecognized_command_word");
  if (INDIRECT_EXECUTORS.has(program)) return ambiguous("indirect_execution");
  const words: Word[] = args.map((text) => ({
    text,
    mask: "n".repeat(text.length),
    quoteOpens: [],
  }));
  if (hasChdirOption(program, words)) return ambiguous("chdir_option");
  return { kind: "cwd" };
}

/** Read a `bash -c` program: reject what cannot be read, then look for a single leading `cd`. */
function readShellProgram(script: string, cwd: string | null): CommandWorkdir {
  const scan = scanProgram(script);
  if (!scan.ok) return ambiguous(scan.reason);

  const cds: { index: number; rank: number; operands: Word[] }[] = [];
  // How many commands ran before this segment. A blank segment (a blank line)
  // is not a command and must not push a leading `cd` out of first place.
  let rank = 0;
  for (const [index, segment] of scan.segments.entries()) {
    const stripped = stripRedirections(segment);
    if (!stripped.ok) return ambiguous(stripped.reason);
    const words = stripped.words;
    const start = firstNonAssignment(words);
    // An assignment prefix, and a segment that is nothing but assignments, can
    // both retune the `cd` that follows.
    for (const word of words.slice(0, start ?? words.length)) {
      const name = assignmentName(word);
      if (name === undefined) continue;
      if (RELOCATING_VARIABLES.has(name)) return ambiguous("shell_state_assignment");
      // The VALUE is read as well, because an expansion inside it can assign to
      // a SECOND variable that the name check never sees: `A=${CDPATH:=/}` sets
      // CDPATH, and a later `cd repos` then lands outside cwd entirely. A
      // segment of nothing but assignments reaches no command word either, so
      // the floor below never gets a chance to refuse it. Rather than enumerate
      // the expansion forms that assign — `${V:=…}`, `${V=…}`, and whatever a
      // later shell adds — an unreadable value is refused outright.
      if (hasLiveDollar(word)) return ambiguous("unreadable_assignment_value");
      // A `~user` in the value can stop the line before the `cd`: measured,
      // `A=~nosuchuser cd /x` aborts zsh with "no such user or named directory"
      // and never runs the `cd`, while bash, dash and ksh assign the text
      // literally and carry on. Only this form fails — `A=~` and `A=~/bin` are
      // read by every shell — so the refusal stays as narrow as the one `cd`
      // already applies to its own operand. (A tilde after a `:`, as in a
      // PATH-style value, is not read here; the common shape carries a `$` and
      // is refused above.)
      if (assignmentValueHasTildeUser(word, name.length)) return ambiguous("tilde_user");
    }
    if (start === undefined) continue; // blank segment, or assignments only
    const head = words[start];
    if (head === undefined) continue;
    // A word shaped like `NAME+=…` or `NAME[…` in command position is either an
    // assignment prefix — in which case the command is the NEXT word, and a
    // `cd` there moved the segment — or it is the command itself, in which case
    // nothing moved. Which one depends on the shell: bash and ksh run the
    // command behind both forms, dash finds neither word, and zsh takes `A[1]=`
    // but rejects `A[0]=` because its arrays are 1-based. For the `NAME[…` form
    // it can depend on the filesystem too, since a pathname expansion in
    // command position reaches the same shape (`c[d]` becomes `cd` where
    // /usr/bin/cd exists). The two readings disagree about whether the command
    // after it ran at all, so neither may be claimed.
    if (looksLikeAssignmentPrefix(head)) return ambiguous("assignment_or_command");
    // Quoting is gone by the time the shell picks the command: `'cd' /x` is a
    // `cd`, and `git "-C" /x` is `git -C /x`.
    if (head.text === "cd") {
      cds.push({ index, rank, operands: words.slice(start + 1) });
      rank++;
      continue;
    }
    rank++;
    // `CMD=cd; $CMD /other` runs the `cd` builtin. What a word in command
    // position expands to is not in the text, so which program ran is unknown —
    // and "unknown program" must not fall through to "nothing moved".
    if (hasLiveDollar(head)) return ambiguous("unexpanded_variable");
    if (SHELL_KEYWORDS.has(head.text)) return ambiguous("compound_command");
    // The floor. Everything above names a shape this grammar knows; this asks
    // whether the word is a program name or path at all, and refuses when it is
    // not. Without it the rule is "answer unless the word matches something on
    // a list of refusals", and a list of shell shapes is never finished: each
    // review round has found another entry missing from it, and every miss is a
    // confident answer that is wrong. Inverted, a miss costs reach instead.
    if (!isPlainCommandHead(head.text)) return ambiguous("unrecognized_command_word");
    const name = basename(head.text);
    if (DIRECTORY_STACK.has(name)) return ambiguous("directory_stack");
    if (INDIRECT_EXECUTORS.has(name)) return ambiguous("indirect_execution");
    const operands = words.slice(start + 1);
    if (hasChdirOption(name, operands)) return ambiguous("chdir_option");
    // `git $OPTS commit` may be hiding a `-C`. Only an UNQUOTED expansion is
    // treated this way: word splitting is what lets one word become `-C` plus
    // its value, and a quoted `"$MSG"` stays a single word no matter what is in
    // it. That keeps `git commit -m "$MSG"` readable, at the cost of not
    // catching a quoted expansion holding a fused `-C/other`.
    if (CHDIR_OPTIONS.has(name) && operands.some((w) => hasUnquoted(w, /\$/))) {
      return ambiguous("unexpanded_variable");
    }
  }

  if (cds.length === 0) return { kind: "cwd" };
  if (cds.length > 1) return ambiguous("multiple_cd");
  const cd = cds[0];
  if (cd === undefined) return ambiguous("unsupported_cd_form");
  // A `cd` after another command means the commands before it ran in cwd and
  // the ones after it did not, so no single directory describes the line. Only
  // the leading form is accepted; the rest is honest abstention.
  if (cd.rank !== 0) return ambiguous("cd_not_first");
  // `cd /other | cat` runs the `cd` in a subshell: the directory it set died
  // with the subshell, and everything after the pipeline ran in cwd.
  if (scan.separators[cd.index] === "|") return ambiguous("cd_in_pipeline");
  return readCdTarget(cd.operands, cwd);
}

/**
 * Single pass over the program, tracking quote state, that either names the
 * construct it refuses to read or returns the segments and their separators.
 *
 * Quote state is not an optimization here: whether a `;` separates, whether a
 * `#` starts a comment, and whether a `$(` substitutes all depend on it, and
 * reading them without it is exactly how a commit message came to decide which
 * repository a commit belonged to.
 */
function scanProgram(script: string): ScanResult {
  const segments: Word[][] = [];
  const separators: Separator[] = [];
  let words: Word[] = [];
  let text = "";
  let mask = "";
  let quoteOpens: number[] = [];
  let started = false; // a word is open (possibly empty, e.g. `cd ""`)

  const endWord = (): void => {
    if (started) words.push({ text, mask, quoteOpens });
    text = "";
    mask = "";
    quoteOpens = [];
    started = false;
  };
  /**
   * Close the segment. A blank line is not a command and is simply skipped;
   * every other separator needs something to its left or bash rejects the
   * program.
   */
  const endSegment = (separator: Separator): boolean => {
    endWord();
    if (words.length === 0) return separator === "newline";
    segments.push(words);
    words = [];
    separators.push(separator);
    return true;
  };
  const runLength = (index: number, char: string): number => {
    let n = 0;
    while (script[index + n] === char) n++;
    return n;
  };
  /** Emit a redirection operator, first discarding an `2`-style fd prefix. */
  const pushRedirection = (op: string): void => {
    if (started && /^\d+$/.test(text) && !/[sd]/.test(mask) && quoteOpens.length === 0) {
      text = "";
      mask = "";
      started = false;
    }
    endWord();
    words.push({ text: op, mask: "n".repeat(op.length), quoteOpens: [], redirection: true });
  };

  let i = 0;
  while (i < script.length) {
    const c = script[i] as string;

    if (c === "'") {
      // Single quotes are literal through and through, so the only thing that
      // can go wrong inside them is not finding the closing quote.
      const close = script.indexOf("'", i + 1);
      if (close === -1) return { ok: false, reason: "unterminated_quote" };
      const body = script.slice(i + 1, close);
      quoteOpens.push(text.length);
      text += body;
      mask += "s".repeat(body.length);
      started = true;
      i = close + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let closed = false;
      quoteOpens.push(text.length);
      while (j < script.length) {
        const d = script[j] as string;
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "\\") return { ok: false, reason: "backslash_escape" };
        if (d === "`") return { ok: false, reason: "backtick" };
        if (d === "$" && script[j + 1] === "(")
          return { ok: false, reason: "command_substitution" };
        text += d;
        mask += "d";
        j++;
      }
      if (!closed) return { ok: false, reason: "unterminated_quote" };
      started = true;
      i = j + 1;
      continue;
    }

    if (c === "\\") return { ok: false, reason: "backslash_escape" };
    if (c === "`") return { ok: false, reason: "backtick" };
    if (c === "$" && script[i + 1] === "(") return { ok: false, reason: "command_substitution" };
    // `$'…'` and `$"…"` are quoting forms whose value is not their text.
    if (c === "$" && (script[i + 1] === "'" || script[i + 1] === '"')) {
      return { ok: false, reason: "dollar_quote" };
    }
    if (c === "(" || c === ")") return { ok: false, reason: "subshell" };
    // `#` is a comment only where a word could start; `sha#1` is one word.
    if (c === "#" && !started) return { ok: false, reason: "comment" };
    // A `\r` is data to the shell, not a line ending, so the line the operator
    // sees and the line bash ran are not the same line.
    if (c === "\r") return { ok: false, reason: "carriage_return" };

    if (c === "<") {
      if (runLength(i, "<") >= 2) return { ok: false, reason: "heredoc" };
      const next = script[i + 1];
      const op = next === "&" || next === ">" ? `<${next}` : "<";
      pushRedirection(op);
      i += op.length;
      continue;
    }

    if (c === ">") {
      const next = script[i + 1];
      const op = next === ">" || next === "&" || next === "|" ? `>${next}` : ">";
      pushRedirection(op);
      i += op.length;
      continue;
    }

    if (c === "&") {
      const n = runLength(i, "&");
      if (n === 2) {
        if (!endSegment("&&")) return { ok: false, reason: "shell_syntax" };
        i += 2;
        continue;
      }
      // A lone `&` is a background job, which splits the line into concurrent
      // halves, and `&>` is not the exception it looks like: it redirects both
      // streams in bash and zsh, but dash and ksh read the `&` as backgrounding
      // the command and the `>` as a redirection of what follows. That is not a
      // cosmetic difference — the backgrounded `cd` runs in a subshell, so its
      // directory dies with it and everything after the `&&` runs in cwd.
      // Measured with `cd /x &>/dev/null && touch RAN`: the file lands in /x
      // under bash and zsh and in cwd under dash and ksh. Reading it either way
      // is a confident wrong directory for the other pair.
      return { ok: false, reason: "background" };
    }

    if (c === "|") {
      if (runLength(i, "|") >= 2) return { ok: false, reason: "or_operator" };
      if (!endSegment("|")) return { ok: false, reason: "shell_syntax" };
      i++;
      continue;
    }

    if (c === ";") {
      // `;;` needs no rule of its own: its second `;` has an empty segment to
      // its left, which is already a syntax error (and `case`, where `;;` is
      // legal, is refused as a compound command).
      if (!endSegment(";")) return { ok: false, reason: "shell_syntax" };
      i++;
      continue;
    }

    if (c === "\n") {
      if (!endSegment("newline")) return { ok: false, reason: "shell_syntax" };
      i++;
      continue;
    }

    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }

    text += c;
    mask += "n";
    started = true;
    i++;
  }

  endWord();
  // `cmd &&` and `cmd |` have nothing on their right: bash rejects the program
  // and runs none of it, so there is no directory to report.
  const last = separators.at(-1);
  if (words.length === 0 && (last === "&&" || last === "|")) {
    return { ok: false, reason: "shell_syntax" };
  }
  segments.push(words);
  return { ok: true, segments, separators };
}

/**
 * Drop redirections and their targets so the remaining words are the command
 * and its operands.
 *
 * The target is READ rather than discarded, because whether the shell could
 * open it decides whether the command ran at all — and a command that never ran
 * has no directory to report. `cd /x 2>&foo` is a bad descriptor in bash, dash
 * and ksh, which run nothing, while zsh reads the word as a file and runs the
 * `cd`. `cd /x > log.*` with two files matching is an "ambiguous redirect" in
 * bash, which runs nothing, while zsh truncates both through multios and dash
 * and ksh create the literal name. `> $UNSET` runs nothing anywhere.
 *
 * The floor cannot cover these: it only looks at words in command position, and
 * a redirection target is not one.
 */
function stripRedirections(words: readonly Word[]): StripResult {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (word.redirection !== true) {
      out.push(word);
      continue;
    }
    const target = words[i + 1];
    // A redirection with no target is a syntax error: bash runs none of the
    // program, so there is no command to place anywhere.
    if (target === undefined || target.redirection === true) {
      return { ok: false, reason: "shell_syntax" };
    }
    if (!isReadableRedirectionTarget(word.text, target)) {
      return { ok: false, reason: "unreadable_redirection" };
    }
    i++; // the redirection consumes its target
  }
  return { ok: true, words: out };
}

/** `>&` and `<&` duplicate a descriptor; their operand is not a filename. */
const FD_DUP_OPERATORS = new Set([">&", "<&"]);

/**
 * What may follow `>&`: a descriptor number, and nothing else.
 *
 * Closing a descriptor (`2>&-`) is left out although all four shells accept it,
 * because a close changes what a LATER redirection on the same line does and
 * this reads each redirection independently rather than carrying descriptor
 * state. Measured, `1>&- 2>&1 && touch RAN` runs nothing in bash, zsh, dash or
 * ksh: the second redirection duplicates the descriptor the first one closed.
 * Accepting the close and not the consequence is how that line came to answer
 * `cwd`.
 *
 * The move form (`2>&1-`) is left out too: measured, dash rejects it and runs
 * nothing while bash, zsh and ksh perform the move.
 */
const FD_DUP_TARGET = /^\d+$/;

/**
 * Whether the shell would certainly have opened this redirection.
 *
 * The question asked of a redirection target is narrower than the one asked of a
 * `cd` target: not WHERE it points, only whether the shell could open it, since
 * that is what decides whether the command ran. So a target only has to be
 * readable as ONE word. `> "$SP/build.log"` is one word whatever `$SP` holds,
 * and whether that file could then be opened is a fact about the filesystem —
 * `cd /x > /absent/f && git commit` runs nothing in bash — which this grammar
 * has never claimed to read, with or without an expansion in the way.
 *
 * What it refuses is a target that may not be one word: an UNQUOTED expansion or
 * glob can become several words or none, and that is where the shells diverge —
 * "ambiguous redirect" and nothing runs in bash and zsh, the first match in dash
 * and ksh.
 */
function isReadableRedirectionTarget(operator: string, target: Word): boolean {
  if (FD_DUP_OPERATORS.has(operator)) return FD_DUP_TARGET.test(target.text);
  // `> ""` names no file, so the shell opens nothing and the command does not run.
  if (target.text.length === 0) return false;
  return !hasUnquoted(target, /[$*?[{]/);
}

// `NAME=`, the one assignment prefix every shell here agrees on.
const ASSIGNMENT_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)=/;

// The START of the append form `NAME+=` and of the array element form
// `NAME[subscript]=`, which the shells do not agree on. Deliberately only the
// start: matching a subscript in full means matching balanced brackets and
// arithmetic, which is the shell-parser this grammar refuses to become — and a
// regex that tries and stops at the first `]` reads `A[1+A[0]]=x` as an
// ordinary command and confidently answers cwd for a segment that moved. Once
// a word begins this way there is nothing further worth deciding, because the
// answer is a refusal either way. See {@link looksLikeAssignmentPrefix}.
const AMBIGUOUS_ASSIGNMENT_START = /^[A-Za-z_][A-Za-z0-9_]*(\[|\+=)/;

/**
 * A word in command position that is a program name or a path to one: `git`,
 * `node_modules/.bin/biome`, `/usr/bin/env`, `./script.sh`, `~/bin/tool`.
 *
 * This is an allowlist on purpose. The characters left out are the ones that
 * make a word mean something other than "run this program" — `[` and `=` and
 * `$` and quotes and non-ASCII names, each of which some shell reads as an
 * assignment, a glob, an expansion, or nothing at all. Rather than enumerate
 * those readings, which is the enumeration that keeps turning out to be
 * incomplete, anything outside this shape is refused.
 */
const PLAIN_COMMAND_HEAD = /^(?:~\/|\/|\.{1,2}\/)?[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/;

/**
 * Whether a word in command position is a program name or a path to one.
 *
 * {@link PLAIN_COMMAND_HEAD} decides the characters; this adds the one thing a
 * character class cannot express, which is that a word naming a DIRECTORY is
 * not naming a program. A trailing `/` and a last segment of `.` or `..` are
 * directories by spelling alone — no filesystem needed — and every shell here
 * refuses to execute one (exit 126), which means the `&&` after it never runs.
 * Answering `cwd` for such a line is a confident answer about work that did not
 * happen.
 *
 * A bare `.` is the exception, and not because it is safe: it is the `source`
 * builtin rather than a path, so it goes on to be refused by name as an
 * indirect executor, which is the more precise reason of the two.
 */
function isPlainCommandHead(text: string): boolean {
  if (!PLAIN_COMMAND_HEAD.test(text)) return false;
  if (text === ".") return true;
  const last = text.slice(text.lastIndexOf("/") + 1);
  return last !== "." && last !== "..";
}

/**
 * The variable a `NAME=value` prefix assigns, if this word is one.
 *
 * The NAME must be unquoted for the shell to read the word as an assignment at
 * all: `FOO="x"` is one and `"FOO"=x` is not. Quoting is checked through
 * {@link quotedBefore} rather than the mask alone, because `FOO""=x` also is
 * not one and its quotes contribute no characters to the mask.
 */
function assignmentName(word: Word): string | undefined {
  if (word.redirection === true) return undefined;
  const match = ASSIGNMENT_PREFIX.exec(word.text);
  if (match?.[1] === undefined) return undefined;
  const upToEquals = match[0].length - 1;
  if (quotedBefore(word, upToEquals)) return undefined;
  return match[1];
}

/**
 * Whether this word in command position might be an assignment prefix rather
 * than the command — the `NAME+=…` and `NAME[…` shapes, as opposed to the
 * portable `NAME=`, which every shell here agrees is a prefix.
 *
 * Only the shape's start is examined, so `A[1+A[0]]=x` and the word-split
 * `A[1` of `A[1 + 1]=x` are both caught. This over-reaches onto words no shell
 * reads as an assignment (`A[[0]=x`) and onto a pathname expansion that lands
 * in command position (`c[d]`); both are cases where what ran is equally
 * unreadable, so the same refusal is the right answer.
 *
 * The same quoting rule applies as for {@link assignmentName}: a quoted NAME is
 * not an assignment in any shell, so the word is an ordinary command and no
 * such question arises.
 */
function looksLikeAssignmentPrefix(word: Word): boolean {
  if (word.redirection === true) return false;
  const match = AMBIGUOUS_ASSIGNMENT_START.exec(word.text);
  if (match === null) return false;
  return !quotedBefore(word, match[0].length - 1);
}

/**
 * Whether an assignment's value begins with an unquoted `~user`, the one tilde
 * form that can fail. `~` and `~/…` resolve in every shell; `~name` is a lookup
 * that zsh treats as fatal.
 */
function assignmentValueHasTildeUser(word: Word, nameLength: number): boolean {
  const at = nameLength + 1; // just past `NAME=`
  if (word.text[at] !== "~" || word.mask[at] !== "n") return false;
  const next = word.text[at + 1];
  return next !== undefined && next !== "/";
}

/** Whether any quoting touched the word at or before `index`, empty quotes included. */
function quotedBefore(word: Word, index: number): boolean {
  if (/[sd]/.test(word.mask.slice(0, index))) return true;
  return word.quoteOpens.some((at) => at <= index);
}

/** Index of the command word, skipping the `NAME=value` prefixes that precede it. */
function firstNonAssignment(words: readonly Word[]): number | undefined {
  for (const [index, word] of words.entries()) {
    if (assignmentName(word) !== undefined) continue;
    return index;
  }
  return undefined;
}

/**
 * Whether this program was given an option that moves its work to another
 * directory. Every spelling counts, because every one of them works:
 * `git -C /other`, `git -C/other`, `git --git-dir=/other/.git`, the clustered
 * `make -sC /other`, and `git "-C" /other` — the shell removes the quotes
 * before git ever sees the word.
 */
function hasChdirOption(program: string, operands: readonly Word[]): boolean {
  const options = CHDIR_OPTIONS.get(program);
  if (options === undefined) return false;
  return operands.some((word) => {
    if (word.redirection === true) return false;
    if (options.has(word.text)) return true;
    const eq = word.text.indexOf("=");
    if (eq > 0 && options.has(word.text.slice(0, eq))) return true;
    if (word.text.startsWith("--") || !word.text.startsWith("-")) return false;
    // A short option carrying its value with no separator (`-C/other`), or
    // clustered with other short options (`make -sC /other`). Both are real
    // spellings, and both used to read as an ordinary argument.
    for (const option of options) {
      if (option.length !== 2 || option.startsWith("--")) continue;
      if (word.text.includes(option.slice(1), 1)) return true;
    }
    return false;
  });
}

/** Whether any character of `text` matching `pattern` was left unquoted. */
function hasUnquoted(word: Word, pattern: RegExp): boolean {
  for (let i = 0; i < word.text.length; i++) {
    if (word.mask[i] === "n" && pattern.test(word.text[i] as string)) return true;
  }
  return false;
}

/** Whether any `$` survived into a position where the shell would have expanded it. */
function hasLiveDollar(word: Word): boolean {
  for (let i = 0; i < word.text.length; i++) {
    if (word.text[i] === "$" && word.mask[i] !== "s") return true;
  }
  return false;
}

/** The one accepted `cd` shape: exactly one operand, optionally behind `--`. */
function readCdTarget(operands: readonly Word[], cwd: string | null): CommandWorkdir {
  let operand: Word | undefined;
  let afterEndOfOptions = false;
  // `--` is the shell's own end-of-options marker and reaches `cd` with its
  // quotes already removed, so `cd '--' /x` is `cd -- /x`.
  if (operands.length === 1) operand = operands[0];
  else if (operands.length === 2 && operands[0]?.text === "--") {
    operand = operands[1];
    afterEndOfOptions = true;
  }
  // No operand is `cd` to `$HOME`, and `cd -` is `$OLDPWD`: both are shell state
  // this grammar does not carry, so neither is guessed at. `cd "-"` is `cd -`
  // too — quoting does not hide an operand from the builtin reading it.
  if (operand === undefined || operand.text.length === 0) {
    return ambiguous("unsupported_cd_form");
  }
  if (!afterEndOfOptions && operand.text.startsWith("-")) {
    return ambiguous("unsupported_cd_form");
  }

  let target = operand.text;
  // An unexpanded `$` anywhere, not just in the last segment: `$ROOT/app` is not
  // a path, and keying it by its spelling lets two unrelated repositories share
  // a key. Inside single quotes a `$` is literal and harmless.
  if (hasLiveDollar(operand)) return ambiguous("unexpanded_variable");
  // A glob or a brace expansion: the shell turned this into some other word (or
  // several), and which one is not recoverable from the text.
  if (hasUnquoted(operand, /[*?[{]/)) return ambiguous("glob");

  if (target.startsWith("~")) {
    // The shell does NOT expand a quoted `~`. Reading it as home would invent a
    // path, and reading it literally would name a directory nobody meant.
    if (operand.mask[0] !== "n") return ambiguous("quoted_tilde");
    if (target === "~") target = homedir();
    else if (target.startsWith("~/")) target = homedir() + target.slice(1);
    else return ambiguous("tilde_user");
  }

  if (!isAbsolute(target)) {
    // Resolved against cwd rather than kept as text: the same `cd ../app` run
    // beside two different repositories is two directories, and keying it by
    // its spelling collapsed them onto one. An unknown cwd is nothing to resolve
    // against, exactly like a relative one.
    if (cwd === null || !isAbsolute(cwd)) return ambiguous("unresolvable_relative");
    target = resolve(cwd, target);
  }
  return { kind: "target", path: target };
}
