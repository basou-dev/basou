import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  readYamlFile,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunNote } from "./note.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const FIXED_NOW = new Date("2026-05-11T12:00:00.000Z");
const FIXED_CTX = { nowProvider: () => FIXED_NOW };

const SES = (suffix: string) => `ses_01HXABCDEF1234567890ABC${suffix}`;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-note-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  if (tmpRepo !== undefined) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getTmpRepo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

async function setupInitedRepo(): Promise<string> {
  const repo = await realpath(getTmpRepo());
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "fixture-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  return repo;
}

async function createSession(repo: string, id: string, status: string): Promise<string> {
  const paths = basouPaths(repo);
  const sessionDir = join(paths.sessions, id);
  await mkdir(sessionDir, { recursive: true });
  await writeYamlFile(join(sessionDir, "session.yaml"), {
    schema_version: "0.1.0" as const,
    session: {
      id,
      label: "test",
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal" as const, version: "0.1.0" as const },
      started_at: "2026-05-08T11:00:00+09:00",
      status,
      working_directory: repo,
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
  await writeFile(join(sessionDir, "events.jsonl"), "");
  return id;
}

function captureStdout() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

async function findAdHocSessionId(repo: string): Promise<string> {
  const dirs = await readdir(basouPaths(repo).sessions);
  const found = dirs.find((d) => d.startsWith("ses_"));
  if (found === undefined) throw new Error("no ad-hoc session directory was created");
  return found;
}

async function readEvents(repo: string, sid: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function readNoteBody(repo: string): Promise<unknown> {
  const sid = await findAdHocSessionId(repo);
  const note = (await readEvents(repo, sid)).find((e) => e.type === "note_added");
  return (note as { body?: unknown } | undefined)?.body;
}

async function readInvocationArgs(repo: string): Promise<unknown> {
  const sid = await findAdHocSessionId(repo);
  const parsed = (await readYamlFile(join(basouPaths(repo).sessions, sid, "session.yaml"))) as {
    session: { invocation: { args: unknown } };
  };
  return parsed.session.invocation.args;
}

async function countSessions(repo: string): Promise<number> {
  try {
    return (await readdir(basouPaths(repo).sessions)).filter((d) => d.startsWith("ses_")).length;
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") return 0;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Text a shell would rewrite if it reached basou inside double quotes: two
// command substitutions, a parameter expansion, and a history-expansion mark.
// It starts and ends with whitespace so a reader that trims (rather than
// dropping only trailing newlines) is caught.
const SHELL_ACTIVE_TEXT =
  "  Next: rebase `topic` onto main, then $(date) and $HOME stay literal!\n  second line\t ";

describe("doRunNote (ad-hoc path)", () => {
  it("creates an ad-hoc session holding a note_added event", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunNote("resume from: ship v0.24.0", {}, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("in ad-hoc session");

    const sid = await findAdHocSessionId(repo);
    const events = await readEvents(repo, sid);
    const note = events.find((e) => e.type === "note_added");
    expect(note).toBeDefined();
    expect((note as { body?: unknown }).body).toBe("resume from: ship v0.24.0");
    // `basou note` marks its note as a resume hint so orient surfaces it.
    expect((note as { kind?: unknown }).kind).toBe("next_step");
  });

  it("rejects an empty / whitespace-only body even via the programmatic entry", async () => {
    const repo = await setupInitedRepo();
    await expect(doRunNote("   ", {}, { cwd: repo, ...FIXED_CTX })).rejects.toThrow(
      /must not be empty/,
    );
  });

  it("refuses a body that is exactly a subcommand-like word (note footgun guard)", async () => {
    const repo = await setupInitedRepo();
    for (const word of ["list", "ls", "show", "LIST", " list ", "help"]) {
      await expect(doRunNote(word, {}, { cwd: repo, ...FIXED_CTX })).rejects.toThrow(
        /has no '.*' subcommand/,
      );
    }
  });

  it("still records a multi-word body that merely contains a reserved word", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunNote("list the open PRs before release", {}, { cwd: repo, ...FIXED_CTX });
    const sid = await findAdHocSessionId(repo);
    const events = await readEvents(repo, sid);
    const note = events.find((e) => e.type === "note_added");
    expect((note as { body?: unknown }).body).toBe("list the open PRs before release");
  });

  it("truncates a long body in the ad-hoc label", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const longBody = "y".repeat(100);
    await doRunNote(longBody, {}, { cwd: repo, ...FIXED_CTX });
    const sid = await findAdHocSessionId(repo);
    // Parse the yaml (a long quoted label is line-folded in the raw text).
    const parsed = (await readYamlFile(join(basouPaths(repo).sessions, sid, "session.yaml"))) as {
      session: { label: string };
    };
    // LABEL_BODY_MAX = 80 -> head 77 chars + "..."
    expect(parsed.session.label).toBe(`Ad-hoc note: ${"y".repeat(77)}...`);
  });

  it("--json emits mode=ad-hoc with the note body", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunNote("next step", { json: true }, { cwd: repo, ...FIXED_CTX });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.mode).toBe("ad-hoc");
    expect(payload.session_status).toBe("completed");
    expect(payload.body).toBe("next step");
    expect(typeof payload.event_id).toBe("string");
    expect(typeof payload.session_id).toBe("string");
  });

  it("collapses a multi-line body into a single-line ad-hoc label", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunNote("line one\n  line two", {}, { cwd: repo, ...FIXED_CTX });
    const sid = await findAdHocSessionId(repo);
    const yaml = await readFile(join(basouPaths(repo).sessions, sid, "session.yaml"), "utf8");
    expect(yaml).toContain("Ad-hoc note: line one line two");
  });
});

describe("doRunNote (--session attach path)", () => {
  it("attaches a note_added to an attachable session", async () => {
    const repo = await setupInitedRepo();
    const id = await createSession(repo, SES("S01"), "running");
    const out = captureStdout();
    await doRunNote("a note", { session: id }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain(`in session`);
    const events = await readEvents(repo, id);
    const note = events.find((e) => e.type === "note_added");
    expect((note as { body?: unknown }).body).toBe("a note");
  });

  it("refuses to attach to an imported (non-attachable) session", async () => {
    // This is exactly why `basou note` defaults to an ad-hoc session: imported
    // sessions (the operator's main workflow) are status=imported, not attachable.
    const repo = await setupInitedRepo();
    const id = await createSession(repo, SES("S02"), "imported");
    await expect(doRunNote("x", { session: id }, { cwd: repo, ...FIXED_CTX })).rejects.toThrow();
    // No note_added event was written to the imported session.
    const events = await readEvents(repo, id);
    expect(events.some((e) => e.type === "note_added")).toBe(false);
  });
});

describe("doRunNote (text from stdin or --file)", () => {
  it("records text read from stdin exactly, dropping only the trailing newlines", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunNote(
      undefined,
      {},
      { cwd: repo, ...FIXED_CTX, readInput: async () => `${SHELL_ACTIVE_TEXT}\n\n` },
    );
    expect(await readNoteBody(repo)).toBe(SHELL_ACTIVE_TEXT);
    // Nothing was passed on the command line, so nothing is recorded as argv.
    expect(await readInvocationArgs(repo)).toEqual([]);
  });

  it("records text read from --file exactly, dropping only the trailing newlines", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await writeFile(join(repo, "next.txt"), `${SHELL_ACTIVE_TEXT}\r\n`);
    await doRunNote(undefined, { file: "next.txt" }, { cwd: repo, ...FIXED_CTX });
    expect(await readNoteBody(repo)).toBe(SHELL_ACTIVE_TEXT);
    expect(await readInvocationArgs(repo)).toEqual(["--file", "next.txt"]);
  });

  it("records an absolute --file path relative to the workspace, not as given", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await writeFile(join(repo, "next.txt"), "from an absolute path\n");
    await doRunNote(undefined, { file: join(repo, "next.txt") }, { cwd: repo, ...FIXED_CTX });
    expect(await readNoteBody(repo)).toBe("from an absolute path");
    // An absolute path would put the machine's layout into `.basou/`.
    expect(await readInvocationArgs(repo)).toEqual(["--file", "next.txt"]);
  });

  it("keeps an argument exactly as passed, trailing newline included", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const readInput = vi.fn(async () => "must not be read");
    await doRunNote("argument text\n", {}, { cwd: repo, ...FIXED_CTX, readInput });
    expect(await readNoteBody(repo)).toBe("argument text\n");
    expect(readInput).not.toHaveBeenCalled();
    expect(await readInvocationArgs(repo)).toEqual(["argument text\n"]);
  });

  it("refuses an argument together with --file and writes nothing", async () => {
    const repo = await setupInitedRepo();
    await writeFile(join(repo, "next.txt"), "from the file");
    await expect(
      doRunNote("from the argument", { file: "next.txt" }, { cwd: repo, ...FIXED_CTX }),
    ).rejects.toThrow(/either as an argument or with --file, not both/);
    expect(await countSessions(repo)).toBe(0);
  });

  it("says where the text can come from when stdin is empty, and writes nothing", async () => {
    const repo = await setupInitedRepo();
    for (const input of ["", "\n", "  \n\n"]) {
      await expect(
        doRunNote(undefined, {}, { cwd: repo, ...FIXED_CTX, readInput: async () => input }),
      ).rejects.toThrow(/^No note text\. Pass it on stdin through a quoted heredoc/);
    }
    expect(await countSessions(repo)).toBe(0);
  });

  it("fails fast at a terminal instead of waiting for stdin", async () => {
    const repo = await setupInitedRepo();
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    // A tripwire on the stream: if the terminal check were skipped, reading
    // would start here (and at a real terminal, wait forever).
    const stdin = process.stdin as unknown as Record<symbol, unknown>;
    const originalIterator = Object.getOwnPropertyDescriptor(stdin, Symbol.asyncIterator);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdin, Symbol.asyncIterator, {
      configurable: true,
      value: () => {
        throw new Error("stdin was read");
      },
    });
    try {
      // No readInput: this is the real stdin path, which must not start reading.
      await expect(doRunNote(undefined, {}, { cwd: repo, ...FIXED_CTX })).rejects.toThrow(
        /^No note text\./,
      );
    } finally {
      if (original !== undefined) {
        Object.defineProperty(process.stdin, "isTTY", original);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      if (originalIterator !== undefined) {
        Object.defineProperty(stdin, Symbol.asyncIterator, originalIterator);
      } else {
        delete stdin[Symbol.asyncIterator];
      }
    }
    expect(await countSessions(repo)).toBe(0);
  });

  it("shows the heredoc on three lines wherever it points at stdin", async () => {
    // Typed on one line, the words after <<'EOF' are unquoted shell words
    // again, so the hint must show the text on its own line.
    const repo = await setupInitedRepo();
    const threeLines = /\n\s*basou note <<'EOF'\n\s*<your note>\n\s*EOF/;
    await expect(
      doRunNote(undefined, {}, { cwd: repo, ...FIXED_CTX, readInput: async () => "" }),
    ).rejects.toThrow(threeLines);
    await expect(doRunNote("list", {}, { cwd: repo, ...FIXED_CTX })).rejects.toThrow(threeLines);
    await expect(doRunNote("-", {}, { cwd: repo, ...FIXED_CTX })).rejects.toThrow(threeLines);
    await expect(
      doRunNote(undefined, {}, { cwd: repo, ...FIXED_CTX, readInput: async () => "-\n" }),
    ).rejects.toThrow(threeLines);
  });

  it("refuses '-' as an argument and points at omitting it to read stdin", async () => {
    // `basou note -` looks like "read stdin" but would record "-" as the next step.
    const repo = await setupInitedRepo();
    for (const body of ["-", " - "]) {
      await expect(doRunNote(body, {}, { cwd: repo, ...FIXED_CTX })).rejects.toThrow(
        /^'basou note -' does not read stdin; .*omit the argument/s,
      );
    }
    expect(await countSessions(repo)).toBe(0);
  });

  it("refuses '-' from stdin or --file without telling the caller to omit the argument", async () => {
    // Here the argument is already omitted; the text itself is the problem.
    const repo = await setupInitedRepo();
    await writeFile(join(repo, "dash.txt"), "-\n");
    for (const run of [
      () => doRunNote(undefined, {}, { cwd: repo, ...FIXED_CTX, readInput: async () => "-\n" }),
      () => doRunNote(undefined, { file: "dash.txt" }, { cwd: repo, ...FIXED_CTX }),
    ]) {
      const error = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((error as Error).message).toMatch(/^The note text is just '-'/);
      expect((error as Error).message).not.toContain("omit the argument");
    }
    expect(await countSessions(repo)).toBe(0);
  });

  it("applies the subcommand-lookalike guard to text from stdin and --file too", async () => {
    const repo = await setupInitedRepo();
    await writeFile(join(repo, "word.txt"), "LS\n");
    await expect(
      doRunNote(undefined, {}, { cwd: repo, ...FIXED_CTX, readInput: async () => "list\n" }),
    ).rejects.toThrow(/has no 'list' subcommand/);
    await expect(
      doRunNote(undefined, { file: "word.txt" }, { cwd: repo, ...FIXED_CTX }),
    ).rejects.toThrow(/has no 'LS' subcommand/);
    expect(await countSessions(repo)).toBe(0);
  });

  it("rejects a whitespace-only --file as an empty note", async () => {
    const repo = await setupInitedRepo();
    await writeFile(join(repo, "blank.txt"), " \n\n");
    await expect(
      doRunNote(undefined, { file: "blank.txt" }, { cwd: repo, ...FIXED_CTX }),
    ).rejects.toThrow(/must not be empty/);
    expect(await countSessions(repo)).toBe(0);
  });

  it("reports an unreadable --file with a fixed message that carries no path", async () => {
    const repo = await setupInitedRepo();
    await mkdir(join(repo, "a-directory"));
    await writeFile(join(repo, "locked.txt"), "secret");
    await chmod(join(repo, "locked.txt"), 0o000);
    const cases: Array<[string, RegExp]> = [
      [join(repo, "missing.txt"), /^--file names a file that does not exist$/],
      [join(repo, "a-directory"), /^--file names a directory, not a file$/],
    ];
    // Root reads a 0o000 file anyway, so the permission case only means
    // something for an ordinary user.
    if (process.getuid?.() !== 0) {
      cases.push([join(repo, "locked.txt"), /^Could not read the file --file names$/]);
    }
    for (const [file, message] of cases) {
      const error = await doRunNote(undefined, { file }, { cwd: repo, ...FIXED_CTX }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, file).toBeInstanceOf(Error);
      expect((error as Error).message, file).toMatch(message);
      expect((error as Error).message, file).not.toContain(repo);
    }
    expect(await countSessions(repo)).toBe(0);
  });

  it("attaches text read from stdin to an existing session with --session", async () => {
    const repo = await setupInitedRepo();
    const id = await createSession(repo, SES("S03"), "running");
    captureStdout();
    await doRunNote(
      undefined,
      { session: id },
      { cwd: repo, ...FIXED_CTX, readInput: async () => `${SHELL_ACTIVE_TEXT}\n` },
    );
    const note = (await readEvents(repo, id)).find((e) => e.type === "note_added");
    expect((note as { body?: unknown }).body).toBe(SHELL_ACTIVE_TEXT);
  });
});

describe("basou note through a real shell", () => {
  // The recommended form is a heredoc whose delimiter is quoted. This runs the
  // built CLI exactly that way from /bin/sh and checks that the shell ran none
  // of the substitutions in the text: the note is recorded verbatim and the
  // commands inside it created nothing. CI builds before it tests; locally run
  // `pnpm -r build` first.
  const distEntry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "dist",
    "index.js",
  );

  it("records a quoted-heredoc note verbatim without running what it names", async () => {
    const repo = await setupInitedRepo();
    const text = "Next: `touch backtick-ran` then $(touch dollar-ran), keep $HOME literal!";
    const script = `"$NODE_BIN" "$BASOU_CLI" note <<'EOF'\n${text}\nEOF\n`;
    try {
      await execFileAsync("/bin/sh", ["-c", script], {
        cwd: repo,
        env: { ...ENV, NODE_BIN: process.execPath, BASOU_CLI: distEntry },
      });
    } catch (error: unknown) {
      throw new Error(
        `basou note failed from /bin/sh; is ${distEntry} built from this source? (pnpm -r build)`,
        { cause: error },
      );
    }
    expect(await readNoteBody(repo)).toBe(text);
    expect(await exists(join(repo, "backtick-ran"))).toBe(false);
    expect(await exists(join(repo, "dollar-ran"))).toBe(false);
  });
});
