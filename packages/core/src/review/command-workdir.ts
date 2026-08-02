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
 * certainty is reported as {@link CommandWorkdirAmbiguous} rather than guessed
 * at, and in particular never falls back to the session's cwd.
 *
 * Widening the grammar later is safe: every shape it does not accept today is
 * already reported honestly, so accepting more can only move lines out of
 * `ambiguous`, never silently change an answer that was already given.
 */

/** Why the grammar refused to name a directory. One per rule, so a test cannot pass for the wrong reason. */
export type CommandWorkdirAmbiguity =
  /** The recorded invocation is not a shape this grammar reads (e.g. `bash script.sh`, `bash -lc …`). */
  | "unsupported_invocation"
  /** `$(…)`: the substitution runs elsewhere and its text is not the command's text. */
  | "command_substitution"
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
  /** More than one `cd`: the effective directory depends on order and success. */
  | "multiple_cd"
  /** A `cd` after the first command: the commands before it ran somewhere else. */
  | "cd_not_first"
  /** The `cd` is part of a pipeline, so it ran in a subshell and changed nothing. */
  | "cd_in_pipeline"
  /** A `cd` form outside the grammar (`cd`, `cd -`, options, several operands). */
  | "unsupported_cd_form"
  /** The target still holds an unexpanded `$`, so its text is not its value. */
  | "unexpanded_variable"
  /** The target is a glob: what it matched at capture time is not recoverable. */
  | "glob"
  /** `~user`: another account's home is not resolvable from here. */
  | "tilde_user"
  /** A quoted `~`, which the shell does NOT expand — treating it as home would invent a path. */
  | "quoted_tilde"
  /** A relative target with no absolute cwd to resolve it against. */
  | "unresolvable_relative"
  /** `pushd` / `popd`: the directory stack is state this grammar does not model. */
  | "directory_stack"
  /** Execution through another program (`sh -c`, `env`, `xargs`, …), which may run its child elsewhere. */
  | "indirect_execution"
  /** An explicit chdir option (`git -C`, `make -C`, …), which moves the work without a `cd`. */
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
 */
const INDIRECT_EXECUTORS = new Set([
  ".",
  "bash",
  "chroot",
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
 * Options that relocate a specific program's work without a `cd`. Keyed by
 * program rather than matched as a bare `-C` anywhere: `grep -C 3` means
 * context lines, and abstaining on every `grep -C` would spend the abstention
 * budget on lines that are not in question.
 */
const CHDIR_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git", new Set(["-C", "--git-dir", "--work-tree"])],
  ["make", new Set(["-C", "--directory"])],
  ["gmake", new Set(["-C", "--directory"])],
  ["env", new Set(["-C", "--chdir"])],
  ["tar", new Set(["-C", "--directory"])],
]);

/**
 * A word of a simple command, with whether ANY part of it was quoted. Quoting
 * is carried because it changes meaning: an unquoted `~` is the home directory
 * while a quoted one is a literal directory named `~`, and an unquoted `*` is a
 * glob while a quoted one is a filename.
 */
type Word = { text: string; quoted: boolean };

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
  const words: Word[] = args.map((text) => ({ text, quoted: false }));
  if (hasChdirOption(program, words)) return ambiguous("chdir_option");
  return { kind: "cwd" };
}

/** Read a `bash -c` program: reject what cannot be read, then look for a single leading `cd`. */
function readShellProgram(script: string, cwd: string): CommandWorkdir {
  const scan = scanProgram(script);
  if (!scan.ok) return ambiguous(scan.reason);

  const cds: { index: number; rank: number; operands: Word[] }[] = [];
  // How many commands ran before this segment. A blank segment (a leading
  // newline, a doubled separator) and a bare `NAME=value` are not commands and
  // must not push a leading `cd` out of first place.
  let rank = 0;
  for (const [index, segment] of scan.segments.entries()) {
    const words = stripRedirections(segment);
    const start = firstNonAssignment(words);
    if (start === undefined) continue; // blank segment, or assignments only
    const head = words[start];
    if (head === undefined) continue;
    // `cd` is a builtin, so it is never spelled as a path.
    if (head.text === "cd") {
      cds.push({ index, rank, operands: words.slice(start + 1) });
      rank++;
      continue;
    }
    rank++;
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
  let quoted = false;
  let started = false; // a word is open (possibly empty, e.g. `cd ""`)
  // The previous character emitted OUTSIDE quotes, to tell a redirection's `&`
  // (`2>&1`) from a background `&`.
  let prevBare = "";

  const endWord = (): void => {
    if (started) words.push({ text, quoted });
    text = "";
    quoted = false;
    started = false;
  };
  const endSegment = (separator: Separator): void => {
    endWord();
    segments.push(words);
    words = [];
    separators.push(separator);
  };
  const runLength = (index: number, char: string): number => {
    let n = 0;
    while (script[index + n] === char) n++;
    return n;
  };

  let i = 0;
  while (i < script.length) {
    const c = script[i] as string;

    if (c === "'") {
      // Single quotes are literal through and through, so the only thing that
      // can go wrong inside them is not finding the closing quote.
      const close = script.indexOf("'", i + 1);
      if (close === -1) return { ok: false, reason: "unterminated_quote" };
      text += script.slice(i + 1, close);
      quoted = true;
      started = true;
      prevBare = "";
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
        j++;
      }
      if (!closed) return { ok: false, reason: "unterminated_quote" };
      quoted = true;
      started = true;
      prevBare = "";
      i = j + 1;
      continue;
    }

    if (c === "\\") return { ok: false, reason: "backslash_escape" };
    if (c === "`") return { ok: false, reason: "backtick" };
    if (c === "$" && script[i + 1] === "(") return { ok: false, reason: "command_substitution" };
    if (c === "(" || c === ")") return { ok: false, reason: "subshell" };
    // `#` is a comment only where a word could start; `sha#1` is one word.
    if (c === "#" && !started) return { ok: false, reason: "comment" };

    if (c === "<") {
      if (runLength(i, "<") >= 2) return { ok: false, reason: "heredoc" };
      text += c;
      started = true;
      prevBare = c;
      i++;
      continue;
    }

    if (c === "&") {
      const n = runLength(i, "&");
      if (n === 2) {
        endSegment("&&");
        prevBare = "";
        i += 2;
        continue;
      }
      // A lone `&` is a redirection when it is fused to one (`2>&1`, `&>log`),
      // and a background job otherwise.
      if (n === 1 && (prevBare === ">" || prevBare === "<" || script[i + 1] === ">")) {
        text += c;
        started = true;
        prevBare = c;
        i++;
        continue;
      }
      return { ok: false, reason: "background" };
    }

    if (c === "|") {
      const n = runLength(i, "|");
      if (n >= 2) return { ok: false, reason: "or_operator" };
      endSegment("|");
      prevBare = "";
      i++;
      continue;
    }

    if (c === ";") {
      const n = runLength(i, ";");
      endSegment(";");
      prevBare = "";
      i += n;
      continue;
    }

    if (c === "\n") {
      endSegment("newline");
      prevBare = "";
      i++;
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      prevBare = "";
      i++;
      continue;
    }

    text += c;
    started = true;
    prevBare = c;
    i++;
  }

  endWord();
  segments.push(words);
  return { ok: true, segments, separators };
}

/** Redirections are not operands: `cd ~/x 2>&1` still has exactly one operand. */
const REDIRECTION = /^(?:\d*(?:>>|>&|>\||<>|<&|>|<)|&>>|&>)/;

/**
 * Drop redirections (and the target of a detached one) so the remaining words
 * are the command and its operands.
 */
function stripRedirections(words: readonly Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    // A quoted word is a value, never an operator: `cd ">"` names a directory.
    if (word.quoted) {
      out.push(word);
      continue;
    }
    const match = REDIRECTION.exec(word.text);
    if (match === null) {
      out.push(word);
      continue;
    }
    // `> out` spends the next word on the redirection; `>out` carries its own.
    if (match[0].length === word.text.length) i++;
  }
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Index of the command word, skipping the `NAME=value` prefixes that precede it. */
function firstNonAssignment(words: readonly Word[]): number | undefined {
  for (const [index, word] of words.entries()) {
    if (!word.quoted && ASSIGNMENT.test(word.text)) continue;
    return index;
  }
  return undefined;
}

/**
 * Whether this program was given an option that moves its work to another
 * directory. All three spellings count, because all three work:
 * `git -C /other`, `git -C/other`, `git --git-dir=/other/.git`.
 */
function hasChdirOption(program: string, operands: readonly Word[]): boolean {
  const options = CHDIR_OPTIONS.get(program);
  if (options === undefined) return false;
  return operands.some((word) => {
    if (word.quoted) return false;
    if (options.has(word.text)) return true;
    const eq = word.text.indexOf("=");
    if (eq > 0 && options.has(word.text.slice(0, eq))) return true;
    // A short option carrying its value with no separator (`-C/other`).
    const short = word.text.slice(0, 2);
    return short.length === 2 && word.text.length > 2 && short !== "--" && options.has(short);
  });
}

/** The one accepted `cd` shape: exactly one operand, optionally behind `--`. */
function readCdTarget(operands: readonly Word[], cwd: string): CommandWorkdir {
  let operand: Word | undefined;
  let afterEndOfOptions = false;
  if (operands.length === 1) operand = operands[0];
  else if (operands.length === 2 && operands[0]?.text === "--" && operands[0]?.quoted === false) {
    operand = operands[1];
    afterEndOfOptions = true;
  }
  // No operand is `cd` to `$HOME`, and `cd -` is `$OLDPWD`: both are shell state
  // this grammar does not carry, so neither is guessed at.
  if (operand === undefined || operand.text.length === 0) {
    return ambiguous("unsupported_cd_form");
  }
  // `--` is the shell's own statement that what follows is not an option, so
  // honouring it here and then rejecting the operand for its leading `-` would
  // be reading the line and then ignoring what it said.
  if (!afterEndOfOptions && !operand.quoted && operand.text.startsWith("-")) {
    return ambiguous("unsupported_cd_form");
  }

  let target = operand.text;
  // An unexpanded `$` anywhere, not just in the last segment: `$ROOT/app` is not
  // a path, and keying it by its spelling lets two unrelated repositories share
  // a key.
  if (target.includes("$")) return ambiguous("unexpanded_variable");
  if (!operand.quoted && /[*?[]/.test(target)) return ambiguous("glob");

  if (target.startsWith("~")) {
    // The shell does NOT expand a quoted `~`; expanding it here would invent a
    // path the command never used.
    if (operand.quoted) return ambiguous("quoted_tilde");
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
