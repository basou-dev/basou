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
 * KNOWN ASSUMPTION, deliberately taken: when a `cd` is separated from what
 * follows by `;` or a newline rather than `&&`, this reads the `cd` as having
 * succeeded. With `&&` that is guaranteed — the later command ran, so the `cd`
 * returned 0 — but with `;` a failed `cd` leaves the rest running in cwd. The
 * captured `;`/newline form is the common one (a multi-line script whose first
 * line is the `cd`), and issue #184 lists `cd /other; git commit` among the
 * lines that must stop being credited to cwd, so it is accepted.
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
  /** An assignment to shell state `cd` itself reads (`HOME`, `CDPATH`, `PWD`, `OLDPWD`). */
  | "shell_state_assignment"
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
  | "chdir_option";

/**
 * Where a captured command ran. Three outcomes, because two were the bug: with
 * only "cwd" and "a path", an unreadable line had to become one of them, and it
 * became cwd.
 */
export type CommandWorkdir =
  /** It ran in the session's cwd, and the grammar read enough of the line to be sure. */
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
 * `command cd /other` moves the shell exactly as `cd /other` does.
 */
const INDIRECT_EXECUTORS = new Set([
  ".",
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
 * Shell state that `cd` itself reads. An assignment to any of these changes
 * where the same `cd` text lands, and this grammar carries the importer's
 * environment, not the captured one.
 */
const CD_STATE_VARIABLES = new Set(["CDPATH", "HOME", "OLDPWD", "PWD"]);

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
  /** A redirection operator (`>`, `2>&`, `&>>`, …), which is syntax rather than an operand. */
  redirection?: true;
};

/** What separated two segments. `|` is kept distinct because it puts its sides in subshells. */
type Separator = ";" | "&&" | "|" | "newline";

type ScanResult =
  | { ok: true; segments: Word[][]; separators: Separator[] }
  | { ok: false; reason: CommandWorkdirAmbiguity };

/**
 * The directory a captured `command_executed` event ran in.
 *
 * `command` is consulted, not just `args`: both importers record shell lines as
 * `bash -c <program>`, but `-c` is a flag on other programs too (`codex -c
 * <config>` is a real captured shape), and reading that config string as a
 * shell program would be reading someone else's text.
 */
export function deriveCommandWorkdir(
  command: string,
  args: readonly string[],
  cwd: string,
): CommandWorkdir {
  const program = basename(command);
  if (SHELLS.has(program)) {
    const script = args.length === 2 && args[0] === "-c" ? args[1] : undefined;
    if (script === undefined) return ambiguous("unsupported_invocation");
    return readShellProgram(script, cwd);
  }
  // A direct exec: there is no shell to interpret a `cd`, so the only way this
  // ran elsewhere is the program itself relocating its child.
  if (INDIRECT_EXECUTORS.has(program)) return ambiguous("indirect_execution");
  const words: Word[] = args.map((text) => ({ text, mask: "n".repeat(text.length) }));
  if (hasChdirOption(program, words)) return ambiguous("chdir_option");
  return { kind: "cwd" };
}

/** Read a `bash -c` program: reject what cannot be read, then look for a single leading `cd`. */
function readShellProgram(script: string, cwd: string): CommandWorkdir {
  const scan = scanProgram(script);
  if (!scan.ok) return ambiguous(scan.reason);

  const cds: { index: number; rank: number; operands: Word[] }[] = [];
  // How many commands ran before this segment. A blank segment (a blank line)
  // is not a command and must not push a leading `cd` out of first place.
  let rank = 0;
  for (const [index, segment] of scan.segments.entries()) {
    const words = stripRedirections(segment);
    if (words === null) return ambiguous("shell_syntax"); // a redirection with no target
    const start = firstNonAssignment(words);
    // An assignment prefix, and a segment that is nothing but assignments, can
    // both retune the `cd` that follows.
    for (const word of words.slice(0, start ?? words.length)) {
      const name = assignmentName(word);
      if (name !== undefined && CD_STATE_VARIABLES.has(name)) {
        return ambiguous("shell_state_assignment");
      }
    }
    if (start === undefined) continue; // blank segment, or assignments only
    const head = words[start];
    if (head === undefined) continue;
    // Quoting is gone by the time the shell picks the command: `'cd' /x` is a
    // `cd`, and `git "-C" /x` is `git -C /x`.
    if (head.text === "cd") {
      cds.push({ index, rank, operands: words.slice(start + 1) });
      rank++;
      continue;
    }
    rank++;
    if (SHELL_KEYWORDS.has(head.text)) return ambiguous("compound_command");
    const name = basename(head.text);
    if (DIRECTORY_STACK.has(name)) return ambiguous("directory_stack");
    if (INDIRECT_EXECUTORS.has(name)) return ambiguous("indirect_execution");
    if (hasChdirOption(name, words.slice(start + 1))) return ambiguous("chdir_option");
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
  let started = false; // a word is open (possibly empty, e.g. `cd ""`)

  const endWord = (): void => {
    if (started) words.push({ text, mask });
    text = "";
    mask = "";
    started = false;
  };
  /** Close the segment. `;`, `&&` and `|` need something to their left. */
  const endSegment = (separator: Separator): boolean => {
    endWord();
    if (words.length === 0 && separator !== "newline") return false;
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
    if (started && /^\d+$/.test(text) && !mask.includes("s") && !mask.includes("d")) {
      text = "";
      mask = "";
      started = false;
    }
    endWord();
    words.push({ text: op, mask: "n".repeat(op.length), redirection: true });
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
      text += body;
      mask += "s".repeat(body.length);
      started = true;
      i = close + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let closed = false;
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
      // `&>file` / `&>>file` redirect both streams; any other lone `&` is a
      // background job, which splits the line into concurrent halves.
      if (n === 1 && script[i + 1] === ">") {
        const op = script[i + 2] === ">" ? "&>>" : "&>";
        pushRedirection(op);
        i += op.length;
        continue;
      }
      return { ok: false, reason: "background" };
    }

    if (c === "|") {
      if (runLength(i, "|") >= 2) return { ok: false, reason: "or_operator" };
      if (!endSegment("|")) return { ok: false, reason: "shell_syntax" };
      i++;
      continue;
    }

    if (c === ";") {
      // `;;` belongs to `case`, which this grammar does not read, and is a
      // syntax error anywhere else.
      if (runLength(i, ";") >= 2) return { ok: false, reason: "shell_syntax" };
      if (!endSegment(";")) return { ok: false, reason: "shell_syntax" };
      i++;
      continue;
    }

    if (c === "\n") {
      endSegment("newline");
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
 * and its operands. Null when a redirection has no target, which is a syntax
 * error rather than a command that ran somewhere.
 */
function stripRedirections(words: readonly Word[]): Word[] | null {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (word.redirection !== true) {
      out.push(word);
      continue;
    }
    const target = words[i + 1];
    if (target === undefined || target.redirection === true) return null;
    i++; // the redirection consumes its target
  }
  return out;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variable a `NAME=value` prefix assigns, if this word is one. The NAME
 * must be unquoted for the shell to read it as an assignment (`FOO="x"` is one,
 * `"FOO"=x` is not) — but the value's quoting does not matter.
 */
function assignmentName(word: Word): string | undefined {
  if (word.redirection === true) return undefined;
  const eq = word.text.indexOf("=");
  if (eq <= 0) return undefined;
  const name = word.text.slice(0, eq);
  if (!NAME.test(name)) return undefined;
  if (word.mask.slice(0, eq).includes("s") || word.mask.slice(0, eq).includes("d"))
    return undefined;
  return name;
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
 * directory. All spellings count, because all of them work: `git -C /other`,
 * `git -C/other`, `git --git-dir=/other/.git`, and `git "-C" /other` — the
 * shell removes the quotes before git ever sees the word.
 */
function hasChdirOption(program: string, operands: readonly Word[]): boolean {
  const options = CHDIR_OPTIONS.get(program);
  if (options === undefined) return false;
  return operands.some((word) => {
    if (word.redirection === true) return false;
    if (options.has(word.text)) return true;
    const eq = word.text.indexOf("=");
    if (eq > 0 && options.has(word.text.slice(0, eq))) return true;
    // A short option carrying its value with no separator (`-C/other`).
    const short = word.text.slice(0, 2);
    return short.length === 2 && word.text.length > 2 && short !== "--" && options.has(short);
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
function readCdTarget(operands: readonly Word[], cwd: string): CommandWorkdir {
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
    // its spelling collapsed them onto one.
    if (!isAbsolute(cwd)) return ambiguous("unresolvable_relative");
    target = resolve(cwd, target);
  }
  return { kind: "target", path: target };
}
