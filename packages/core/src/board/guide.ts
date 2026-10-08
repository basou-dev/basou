import { createHash } from "node:crypto";
import { decodeTime } from "ulid";
import { displayPath } from "../lib/display-path.js";
import {
  BOARD_STAGE_IDS,
  type BoardDeclaration,
  type BoardObserve,
  isCalendarDate,
} from "./declaration.js";
import { daysBetween, todayIn } from "./effort.js";
import { BOARD_INIT_SAVE } from "./init.js";
import type { BoardPreviousRecords } from "./previous.js";

/**
 * The steps an agent follows to judge a board and record it, filled in with
 * one workspace's values: where the board is, the commands that measure,
 * observe, record and show it, what each stage is judged by, and the input a
 * record takes, with the previous record's cells beside each one. It is
 * prose for an agent to read, not input for a program, so its shape is not
 * promised. Building it reads nothing and writes nothing; the caller hands
 * in what it read.
 */
export type BoardGuideInput = {
  /** The real absolute path of the workspace's own repo, where the board is kept. */
  anchor: string;
  /** The paths of the manifest's other repos, as the manifest writes them. */
  otherRepos: readonly string[];
  /** The language the prose and reasons are written in: the anchor's. */
  language: "en" | "ja";
  /** The command that printed the guide, to call when `basou` is not on PATH. */
  basouCommand: string;
  /** The version of basou printing the guide. */
  basouVersion: string;
  now: Date;
  board:
    | { status: "undeclared" }
    | {
        status: "declared";
        declaration: BoardDeclaration;
        /** How many records `records/` holds. */
        recordCount: number;
        previous: BoardPreviousRecords;
      };
};

/** The ports the board page is opened on: none of them is basou view's default (4319). */
export const BOARD_GUIDE_PORTS = { first: 4400, count: 600 } as const;

function anchorHash(anchor: string): Buffer {
  return createHash("sha256").update(anchor).digest();
}

/**
 * The port a workspace's board page is opened on: the same for the same
 * path, chosen from {@link BOARD_GUIDE_PORTS} by the path's hash, so two
 * workspaces rarely meet and one that does moves to the next port.
 */
export function boardGuidePort(anchor: string): number {
  return BOARD_GUIDE_PORTS.first + (anchorHash(anchor).readUInt32BE(0) % BOARD_GUIDE_PORTS.count);
}

/** The directory, under the temporary one, that one workspace's working files go in. */
export function boardGuideWorkDir(anchor: string): string {
  return `\${TMPDIR:-/tmp}/basou-board-${anchorHash(anchor).toString("hex").slice(0, 12)}`;
}

/** A word for a POSIX shell: single quotes, with each quote in it closed and reopened. */
export function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// JSON with what a terminal would act on escaped as well: JSON.stringify
// leaves the C1 controls, the line and paragraph separators and the
// bidirectional controls as they are.
function jsonText(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(
    /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

const LANGUAGE_NAMES = { en: "English (en)", ja: "Japanese (ja)" } as const;

/** Print the guide. */
export function boardGuide(input: BoardGuideInput): string {
  const anchor = shellWord(input.anchor);
  const work = boardGuideWorkDir(input.anchor);
  // The working directory may sit in a /tmp other users share: it is used
  // only when it is no link and this user's own, and only this user can
  // read it (it holds what the trail holds).
  const go = `cd ${anchor} && W="${work}" && mkdir -p "$W" && { { [ ! -L "$W" ] && [ -O "$W" ]; } || { echo "not a directory of your own, so not used: $W" >&2; false; }; } && chmod 700 "$W"`;
  const out: string[] = [];
  const line = (...lines: string[]) => out.push(...lines);
  const fenced = (lang: string, ...lines: string[]) =>
    out.push("", `\`\`\`${lang}`, ...lines, "```", "");
  const block = (...lines: string[]) => fenced("sh", ...lines);

  line(
    "# How to update this workspace's progress board",
    "",
    `Printed by \`basou board guide\` (basou ${input.basouVersion}). basou board is experimental: its commands, files and shapes may change at any release. This command wrote nothing and sent nothing.`,
    "",
    "The board answers one question: what can be used now, and what is stuck; not what was built. basou measures, records and draws it. You, the agent, judge each lane at each stage, write the prose and make the observations outside basou. basou never judges and never goes on the network.",
    "",
  );

  if (input.board.status === "undeclared") {
    line(basouLine(input), "");
    undeclared(input, go, line, block);
    return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
  }
  const { declaration: d, previous, recordCount } = input.board;
  const port = boardGuidePort(input.anchor);
  const lastId = previous.last.status === "found" ? previous.last.id : null;

  line("## This board", "");
  line(`- Workspace (its own repo): ${displayPath(input.anchor)}`);
  line(
    `- Declaration: board/board.yaml, "${displayPath(d.title)}", board_version ${d.board_version}, ${count(d.lanes.length, "lane")}, ${count(d.observe.length, "observation")} outside basou`,
  );
  line(`- Records: board/records/, ${recordsLine(input, recordCount)}`);
  line(`- Axis: ${axisLine(input)}`);
  line(
    `- Language: write every prose string and reason in ${LANGUAGE_NAMES[input.language]}, the language this board's page is drawn in (Japanese when the manifest declares ja for this repo, English otherwise)`,
  );
  line(`- Board page port: ${port}`);
  line(`- Working files: ${work} (W in the commands below)`);
  line(`- ${basouLine(input)}`);
  line("");

  line(
    "## Rules for every step",
    "",
    "- Run each block on its own: a shell variable does not carry over to the next call. Each block that uses W goes to the workspace and names W first.",
    "- Keep working files in W, never in a repo. A block stops before using W unless it is a directory of your own and not a link (it says so on stderr), and makes it readable by you alone: it holds what the trail holds.",
    "- From the measure of step 2 to the record of step 7, write nothing to basou (`decision capture`, `note`, `task`, `review record`, `refresh`), put no file in and change no file of any repo the manifest declares, do not rebuild or upgrade basou, and do not change `~/.basou/portfolio.yaml`. Each of these can move what the measurement's digest covers (the trail, the repos' files and uncommitted paths, the basou that measured, the portfolio's counts), and record refuses a digest that moved; not every change moves it, so do not count on record to catch one.",
    '- The model name is your own report of yourself. Use the same name every time, as measure\'s `--model` and as `judged_by.model`. In the commands, `$MODEL` stands for it: put the name in its place, or set `MODEL="<name>"` at the start of each block. A block run with it unset stops: measure refuses an empty `--model`.',
    "- Isolation, both ways: read and write only this workspace. Do not open another project's repos, planning, `.basou/` or transcripts (other directories under `~/.claude/projects`, `~/.codex/sessions`), not even to read. Write the board only under board/ of this repo; never write it, its numbers or this work into a public repo or one whose contents are published (no file, `.gitignore` comment, commit message, issue or pull request). Do not bring other projects' names, paths, numbers or ids into the board, nor take this one's out. Asked about another project, decline and suggest a session of its own.",
    "",
  );

  line("## Steps", "");

  line("### 0. Take the before of the other repos", "");
  if (input.otherRepos.length === 0) {
    line(
      "The manifest declares no repo but this one: nothing to take. Gate (d) of step 9 is not needed.",
      "",
    );
  } else {
    line(
      "Gate (d) of step 9 compares the other repos with this. If a repo cannot be read, stop: a repo left out of the comparison would change unseen.",
    );
    block(`${go} && ( ${snapshotLoop(input.otherRepos)} ) > "$W/before.txt"; echo "exit=$?"`);
    line(
      "It keeps each repo's HEAD (or that it has no commit yet) and a hash of what its working tree holds beyond HEAD: the changes to tracked files and the content of untracked ones that are not ignored.",
      "",
    );
  }

  line(
    "### 1. Check how fresh the trail is (the operator's turn)",
    "",
    "Sessions not yet imported leave the active time and the decisions as of the last import.",
  );
  block(`${go} && basou board measure --model "$MODEL" > "$W/measure.txt"; echo "exit=$?"`);
  line(
    "Under `Freshness:` in `$W/measure.txt`, `not imported N new, N updated, N unverifiable`: when any is above 0, show the operator this line to run, and do not run it yourself (it writes the trail):",
  );
  block(`cd ${anchor} && basou refresh`);
  line(
    "Never suggest `--force` without a reason you can state. This session counts among the new or updated ones, so 0 is not to be expected. If the operator does not run it, say so in a footnote.",
    "",
  );

  line("### 2. Measure");
  block(
    `${go} && basou board measure --json --model "$MODEL" > "$W/measure.json"; echo "exit=$?"`,
    `${go} && basou board measure --model "$MODEL" > "$W/measure.txt"; echo "exit=$?"`,
  );
  line(
    "- Exit 0: everything was measured. Exit 1 with JSON on stdout: measured with gaps (`complete: false`, a null for each, its reason under `not_found`). Exit 1 with nothing on stdout: read stderr and stop. The declaration or the manifest cannot be read (fix board.yaml through step 2b), `--model` was empty, or W was not used.",
    "- An empty file means it did not run, not that it passed: check that measure.json reads as JSON.",
    '- Never read a null as 0. Write "not confirmed" for it and do not judge by it.',
    "- What moved is the point: the top of measure.txt (`Since the previous record <ULID>:`) and `diff` in the JSON. A value marked `method_changed` may have moved because basou measures it another way now.",
    "- `repos[].behind_main` counts from the last fetch; measure does not fetch.",
    "",
  );

  line(
    "### 2b. Review the axis (only when `axis.review_needed` is true; apply nothing yourself)",
    "",
    "The axis (the lanes, what each stage means, the measures, the observations and the registry of components) was cut once by a model at a time. The components change and models move on, so a fixed axis pours right numbers into old boxes. `axis.reasons` says what fired:",
    "",
    "- (a) the components changed (unacknowledged, gone or of other kinds): required, before judging",
    "- (b) `review_due_days` passed since the last review: advised",
    "- (c) the model judging is not the one that reviewed last: advised",
    "- (d) the operator asked: by hand",
    "- (e) a built-in section measures another way than at the previous record: advised",
    "",
    "Read board.yaml, the commits that changed it (`git log --format='%ad %h %s' --date=short -- board/board.yaml`), the last review, the components in measure.json and the decisions recorded since (`.basou/decisions.md`, which is as of the last `basou refresh` or `basou decisions generate`: when step 1 found sessions not imported and the operator did not refresh, the latest decisions may be missing from it, and the proposal says so). Then write one proposal to `$W/axis-proposal.md`: (A) what stays, with why; (B) what changes, as a diff of board.yaml; (C) what to ask the operator. Answer:",
    "",
    "1. Each lane: does it still stand as who uses what? Do its stages' conditions fit what is built now? Merge, split, retire or keep, with one sentence why even for keep.",
    "2. Each unacknowledged component: does it change a lane's conditions, make a new lane, or count in no lane (and why)? For the first two, what to measure or observe for it.",
    "3. Each gone component: done with, or a repo in another state? If done with, take it off the registry and fix the lane's conditions.",
    "4. Do the decisions recorded hold anything that should move the axis (a new surface, a new base, something decided not to build)?",
    "5. If the last review was by another model: does anything in how the lanes are cut or worded need fixing now? Change nothing only to make it look new; change only what is worth losing the comparison with past records.",
    "",
    'Apply nothing until the operator approves. Then edit board.yaml, measure again from step 2 (the digest moves with the declaration), and give the record an `axis_review`: `{ "triggers": [every letter that led to it], "summary": "what was reviewed and decided" }`. Raise `axis.version` when a lane is added or removed or a stage\'s condition changes, and name the commit `axis review v<version>`. Give `axis_review` even when nothing changed: the next (b) counts from it. Registering a component only to silence (a) is not a review.',
    "",
  );

  line("### 3. Observe outside basou", "");
  observeSteps(d.observe, go, line, block);

  line("### 4. Judge every lane at every stage", "");
  judging(d, line);

  line("### 5. Compare with the previous record", "");
  if (lastId === null) {
    line(
      previous.last.status === "unreadable"
        ? `The previous record cannot be read (${displayPath(previous.last.reason)}). Judge with no record to compare with, and say so in a footnote.`
        : "There is no record yet: this is the first. Nothing is compared, and an observation not made is drawn as not confirmed, with no previous value.",
      "",
    );
  } else {
    line(
      `The previous record is ${lastId}. Its state and reason are beside each cell of the template in step 6, for reference only: judge each cell again. A cell that moved needs a reason the prose can state; if you cannot state it, the judgement is early. \`record --dry-run\` (step 7) lists the cells that moved.`,
      "",
    );
  }

  line(
    "### 6. Write the record's input",
    "",
    "Write it to `$W/input.json` from a file you edit, not a heredoc (a shell expands backquotes in one and drops words), starting from the template below:",
    "",
    "- `measure_digest`: the `digest` of `$W/measure.json`.",
    '- `observed`: when the board declares observations, one entry per declared observation, under its key, each as step 3 says; nothing else and nothing left out, or record refuses it. An observation made has no `error`; one not made has `"value": null` and an `error`. With none declared, `observed` may stay empty.',
    "- `cells`: every lane at every stage. Set each `state` and delete each `previous`: record refuses a cell with an empty state or a `previous`. `blocked`, `shelved` and `unverified` need a `reason`.",
    `- \`prose\`: \`summary\`, \`lanes\`, \`operator_turns\` as \`{ "text", "source" }\` and \`footnotes\`, all plain strings (HTML is shown as text; only \`\` \`code\` \`\` is drawn as code). Do not repeat what basou draws (the heading, the tiles, the period and effort, the matrix, the ratios, the axis version and the model). Do not start a lane's prose with its \`about\`: the page draws the about right before it. Give \`lanes\` an entry only for a lane you have something to say about (an empty string is drawn as an empty paragraph); the lane ids are ${d.lanes.map((l) => `\`${l.id}\``).join(", ")}.`,
    '- `axis_review`: null, or `{ "triggers": [...], "summary": "..." }` as step 2b says.',
    "",
  );
  fenced("json", templateOf(d, previous));

  line(
    "### 7. Record",
    "",
    "First check without writing (where it goes, the input's shape, every cell, the reasons, the measurement again and what moved):",
  );
  block(`${go} && basou board record --file "$W/input.json" --dry-run; echo "exit=$?"`);
  line(
    "A refusal lists every reason on stderr. A digest that differs means something measured moved since step 2, or basou was rebuilt or upgraded: measure again from step 2 (the judgement can be kept where nothing it rests on moved). When it checks out, write it:",
  );
  block(`${go} && basou board record --file "$W/input.json"; echo "exit=$?"`);
  line(
    "It prints where the record is and what moved since the previous one. A record cannot be taken back (only a later one added), and nothing goes to the trail: what moved is recorded in step 10.",
    "",
  );

  line(
    "### 8. Open the board",
    "",
    `Start the view in the background (run_in_background, or append \`&\`) and open http://127.0.0.1:${port}/board (\`?record=<ULID>\` opens a past record):`,
  );
  block(`cd ${anchor} && basou view --port ${port} --no-open`);
  line(
    `If it stops with \`Port ${port} is already in use.\`, do not query that port (another board may be there): start it on ${port + 1}, and so on. Once it runs, check that it is this board (it prints the title, or why there is none to draw):`,
  );
  block(
    `curl -s http://127.0.0.1:${port}/api/board | node -e 'let t="";process.stdin.on("data",(d)=>{t+=d}).on("end",()=>{const p=JSON.parse(t).page;console.log(JSON.stringify(p.status==="ok"?p.board.heading.title:"unavailable: "+p.why))})'`,
  );
  line(`(On the port it did start on, if not ${port}.)`);
  line(
    "Look at the page before committing: a record cannot be taken back. Stop the view when done.",
    "",
  );

  line(
    "### 9. Commit",
    "",
    "Commit only when every gate passes; if one fails, stop and ask the operator.",
    "",
  );
  if (input.otherRepos.length > 0) {
    line("(d) The other repos are as they were at step 0 (it prints `(d) same`):");
    block(
      `${go} && ( ${snapshotLoop(input.otherRepos)} ) > "$W/after.txt" && diff "$W/before.txt" "$W/after.txt" && echo "(d) same"`,
    );
  }
  line(
    "(e) Only board/ is staged: add it alone; it prints `(e) only board/`, or what else is staged.",
  );
  block(
    `cd ${anchor} && git add -- board && if git diff --cached --name-only | grep -v '^board/'; then echo "(e) more than board/ is staged"; false; else echo "(e) only board/"; fi`,
  );
  line(
    "(f) No one outside can read this repo. On GitHub: visibility PRIVATE, no collaborator but the owner, no invitation. Look at the numbers only, never the names:",
  );
  block(
    `cd ${anchor} && SLUG=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\\.git$##') && gh repo view "$SLUG" --json visibility -q .visibility && gh api "repos/$SLUG/collaborators?affiliation=all" --jq "[.[] | select(.login != \\"\${SLUG%%/*}\\")] | length" && gh api "repos/$SLUG/invitations" --jq length`,
  );
  line(
    "It should print PRIVATE, 0 and 0 (for a repo an organization owns, ask the operator who can read it). Not on GitHub: ask the operator. Then commit:",
  );
  block(`cd ${anchor} && git commit -m "board: record of $(date +%Y-%m-%d)"`);
  line(
    "Name it `axis review v<version>` after an axis review. Push it the way this repo is kept. A commit keeps the board's history: three weeks later, the board of then can still be opened.",
    "",
  );

  line(
    "### 10. Record what moved (after step 7)",
    "",
    '- A cell moved (blocked to done, and so on): `basou decision capture` with `"kind": "decision"`.',
    '- Something newly stuck that only a person can settle: the same with `"kind": "track"`.',
    "- What to do next: `basou note`, with the text on stdin through a quoted heredoc.",
    "",
    "Nothing moved: write nothing. Pass JSON and long text through a file; `alternatives` and `linked_files` are lists, not strings.",
    "",
  );

  line(
    "## What the board page draws, and what you write",
    "",
    "1. Heading: basou draws it (title, when recorded, the model, whether everything was measured).",
    "2. Summary: `prose.summary`, what matters this time and what moved since the last record. basou draws the tiles and the table of observations.",
    "3. Period and effort: basou draws it. Write nothing that gives the numbers a meaning.",
    "4. Reach matrix: your `cells`. basou draws the legend, the order anomalies and the cells that moved.",
    "5. Each lane: `prose.lanes`. For a stuck lane, one sentence on what would move it, with the measured values it rests on.",
    "6. Ratios: basou draws them.",
    "7. Operator's turns: `prose.operator_turns`, the items waiting for a ruling (not for implementation), the ones that move most first, each with its source (a decision or task id, a pull request) in `source`. This is what is read most: what the operator can do to move the board.",
    "8. Footnotes: `prose.footnotes`, what was not confirmed, what is estimated, whether the trail was refreshed, a build that is not the repo's main. basou adds the axis, the model, what was not measured and which basou measured.",
    "",
    "## Do not",
    "",
    "- Write the trail: `basou refresh` is the operator's.",
    "- Write to basou between measure and record.",
    "- Argue priorities: the board lists facts, and the operator's turns list what waits for a ruling.",
    "- Write an estimate as a measurement, or let a number you could not get pass as blank or 0.",
    "- Put money on the board, or read effort as progress: reach is shown by the matrix alone.",
    "- Change the axis silently, or register a component only to silence (a).",
    "- Write the board's HTML: basou draws it.",
    "- Touch another project's repos.",
    "",
    "## The operator's turns in this work",
    "",
    "- Running `basou refresh` when step 1 finds sessions not imported.",
    "- Approving an axis review (step 2b) before anything in board.yaml changes.",
  );
  for (const o of d.observe) {
    if (o.kind === "manual") line(`- Observing \`${o.key}\`: ${displayPath(o.how)}`);
  }
  line("- A gate of step 9 that does not pass.", "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function basouLine(input: BoardGuideInput): string {
  return `basou: \`${displayPath(input.basouCommand)}\` printed this. Where \`basou\` is not on PATH (an alias of an interactive shell) or is another version, call that instead, and the same one at every step: a measurement records which basou measured it.`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Each other repo's HEAD (or no-commit) and a hash of what its working tree
// holds beyond it: the diff of tracked files against HEAD (or, with no commit
// yet, against the index and the index against nothing), the names of the
// untracked files that are not ignored and their contents. Hashed, never
// written: git hash-object without -w stores nothing. A repo that is not a
// git repo, or cannot be read, stops it.
function snapshotLoop(repos: readonly string[]): string {
  return `for d in ${repos.map(shellWord).join(" ")}; do git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || { echo "cannot read $d" >&2; exit 1; }; h=$(git -C "$d" rev-parse -q --verify HEAD || echo no-commit); s=$(cd "$d" && { if [ "$h" = no-commit ]; then git diff --binary --cached && git diff --binary; else git diff --binary HEAD; fi && git ls-files -o --exclude-standard && git ls-files -o --exclude-standard | git hash-object --stdin-paths; } | git hash-object --stdin) || { echo "cannot read $d" >&2; exit 1; }; echo "$d $h $s"; done`;
}

function ago(from: string, to: string): string {
  const days = daysBetween(from, to);
  return days === 0 ? "today" : `${count(days, "day")} ago`;
}

function recordsLine(input: BoardGuideInput, recordCount: number): string {
  if (input.board.status !== "declared") return "";
  const { last } = input.board.previous;
  if (recordCount === 0 && last.status === "none") return "none yet; this will be the first";
  const today = todayIn(input.board.declaration.effort.time_zone, input.now);
  if (last.status === "found") {
    const at = new Date(decodeTime(last.id));
    const day = todayIn(input.board.declaration.effort.time_zone, at);
    const when = day !== undefined && today !== undefined ? `, ${ago(day, today)}` : "";
    return `${count(recordCount, "record")}; the last is ${last.id}, recorded ${at.toISOString()}${when}`;
  }
  if (last.status === "unreadable") {
    return `${count(recordCount, "record")}; the last cannot be read (${displayPath(last.reason)})`;
  }
  return count(recordCount, "record");
}

function axisLine(input: BoardGuideInput): string {
  if (input.board.status !== "declared") return "";
  const { declaration: d, previous } = input.board;
  const head = `version ${d.axis.version}, due a review every ${count(d.axis.review_due_days, "day")}`;
  const { lastReview } = previous;
  if (lastReview.status === "found") {
    const day =
      todayIn(d.effort.time_zone, new Date(lastReview.record.recorded_at)) ??
      new Date(lastReview.record.recorded_at).toISOString().slice(0, 10);
    return `${head}; last reviewed ${day} by ${displayPath(lastReview.record.judged_by.model)} (record ${lastReview.id})`;
  }
  if (lastReview.status === "unreadable") {
    return `${head}; the last review is not known (a record cannot be read)`;
  }
  const seed = d.axis.seed_review;
  if (seed !== undefined && isCalendarDate(seed.date)) {
    return `${head}; last reviewed ${seed.date} by ${displayPath(seed.model)} (seed_review in board.yaml)`;
  }
  return input.board.recordCount === 0 && previous.last.status === "none"
    ? `${head}; no review on record (the first record is the first review: give it an axis_review, step 2b)`
    : `${head}; no review on record (measure's axis section says whether one is due)`;
}

// How each declared observation is made, and how it is written down.
function observeSteps(
  observe: readonly BoardObserve[],
  go: string,
  line: (...lines: string[]) => void,
  block: (...lines: string[]) => void,
): void {
  if (observe.length === 0) {
    line(
      "This board declares nothing to observe outside basou. If a lane reaches its users through something outside the repos (a package registry, a release, a site, a production database), declare it under `observe` (board_version 2) through an axis review (step 2b).",
      "",
    );
    return;
  }
  line(
    'Read only: these commands write nothing and change nothing. Make each one, and write it under its key in `observed` as `{ "value": <value>, "observed_at": <when>, "source": <what you asked> }`. `observed_at` is the time with its offset, such as `date -u +%Y-%m-%dT%H:%M:%SZ` prints. When it cannot be made (a command failed, nothing to read, no answer), write `"value": null` and an `"error"` saying why: the board then shows it as not confirmed, with the previous record\'s value. Never carry an old value forward as today\'s. Keep the keys: they join each value to the previous record\'s.',
    "",
  );
  for (const o of observe) {
    line(`#### \`${o.key}\` (${o.kind})`, "");
    switch (o.kind) {
      case "npm_version":
        line(`The version of ${o.package} published on npm (its \`latest\` tag):`);
        block(`npm view ${shellWord(o.package)} version; echo "exit=$?"`);
        line(
          `Value: the last line of the output, as a string (such as "1.2.3"). Source: \`${sourceOf(o)}\`.`,
          "",
        );
        break;
      case "github_release":
        line(`The latest release of ${o.repo} on GitHub:`);
        block(
          `gh release view --repo ${shellWord(o.repo)} --json tagName -q .tagName; echo "exit=$?"`,
        );
        line(
          `Value: the tag, as a string. No release yet is a null with that as the error. Source: \`${sourceOf(o)}\`.`,
          "",
        );
        break;
      case "github_open_issues":
      case "github_open_prs": {
        const what = o.kind === "github_open_issues" ? "issue" : "pr";
        line(`How many ${what === "issue" ? "issues" : "pull requests"} of ${o.repo} are open:`);
        block(
          `gh ${what} list --repo ${shellWord(o.repo)} --state open --limit 1000 --json number -q length; echo "exit=$?"`,
        );
        line(
          `Value: the number, as a number. At 1000 there may be more: say so in a footnote. Source: \`${sourceOf(o)}\`.`,
          "",
        );
        break;
      }
      case "github_ci":
        line(`How the latest run of the workflow ${o.workflow} on ${o.branch} of ${o.repo} ended:`);
        block(
          `gh run list --repo ${shellWord(o.repo)} --workflow ${shellWord(o.workflow)} --branch ${shellWord(o.branch)} --limit 1 --json status,conclusion -q '.[0] | if .status == "completed" then .conclusion else .status end'; echo "exit=$?"`,
        );
        line(
          `Value: what it prints, as a string (\`success\`, \`failure\`, or the status of a run not finished, such as \`in_progress\`). Nothing printed (no run) is a null with that as the error. Source: \`${sourceOf(o)}\`.`,
          "",
        );
        break;
      case "page_version":
        line(
          `The version ${o.url} shows: the first \`v<major>.<minor>.<patch>\` (with what follows a \`-\`) not right after a letter, digit, underscore or dot, once the page's generator meta tags are taken out, however they are quoted or cased (they name the site builder's version, not the product's).`,
        );
        block(
          `${go} && curl -fsS --max-time 20 ${shellWord(o.url)} > "$W/page-${o.key}.html"; echo "curl exit=$?"`,
          `${go} && node -e 'let t="";process.stdin.on("data",(d)=>{t+=d}).on("end",()=>{const m=t.replace(/<meta\\b[^>]*\\bname\\s*=\\s*["\\x27]?generator\\b[^>]*>/gi,"").match(/(?<![\\w.])v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?/);if(m===null){process.exitCode=1}else{console.log(m[0])}})' < "$W/page-${o.key}.html"; echo "exit=$?"`,
        );
        line(
          `Value: the version it prints, as a string (such as "v1.2.3"). A failed fetch, or no version on the page (exit 1), is a null with that as the error. Source: \`${sourceOf(o)}\`.`,
          "",
        );
        break;
      case "manual":
        line(
          `Only the operator can make this one: ${displayPath(o.how)}`,
          "",
          "Ask the operator, and do not make it yourself. With no answer this time, write a null and say so as the error. Source: `the operator`.",
          "",
        );
        break;
    }
  }
}

// The stages and lanes as the declaration has them, and the principles of judging.
function judging(d: BoardDeclaration, line: (...lines: string[]) => void): void {
  line(
    "The six stages come in order: a stage is not reached before the one before it, so the board shows where each lane stops. What each means on this board, and what to look at:",
    "",
  );
  for (const id of BOARD_STAGE_IDS) {
    const stage = d.stages[id];
    line(`- ${id}: ${displayPath(stage.meaning)}`);
    for (const look of stage.look ?? []) line(`  - look at: ${displayPath(look)}`);
    for (const note of stage.notes ?? []) line(`  - mind: ${displayPath(note)}`);
  }
  line(
    "",
    "04 (merged, in production) and 05 (open, in users' hands) are apart on purpose: what is merged but not published is used by no one. There is more than one way out, and one closed is enough to make 05 `part` or `blocked`.",
    "",
    "The states of a cell:",
    "",
    "- `done` (drawn \u25cf): the condition is met",
    "- `part` (\u25d0): met for some of its surfaces or features",
    "- `blocked` (\u25a0): stuck here; what the next step needs is missing. Needs a reason",
    "- `shelved` (\u2298): stopped on purpose, by a settled decision. Needs a reason naming that decision. Not a failure",
    "- `none` (\u25cb): not started",
    "- `unverified` (?): this board cannot confirm it (a run only another workspace can make). Needs a reason. Not when this board could check it and you did not: measure it, or say in a footnote why not",
    "",
    "Principles:",
    "",
    '1. Do not judge a stage generously. "Mostly works" is `part`, not `done`: the board is worth what it says about what has not arrived.',
    "2. What is not committed is not 04. Work left in a working tree stops at 03: written is not merged.",
    "3. Give a stuck cell its reason in one sentence. A reason you cannot write means the judgement is early.",
    "4. Do not paint a shelved cell red. Shelving is a decision; blaming it makes stopping harder and bends judgement.",
    "5. Do not mix estimates and measurements. Plans and estimates are not results: name them in a footnote.",
    "6. When a number falls, find out why. Counts of files or commands rarely fall: the measuring may have broken, or a repo is in another state.",
    "7. Do not bend a stage to get a record through. A stage left behind before a later one done is recorded as an order anomaly and shown, not refused: if that is the fact, write it.",
    "",
    "Where judging goes wrong most: 04 taken for 05; uncommitted work counted as 04; `blocked` and `shelved` mixed up (stuck, or stopped on purpose); what cannot be confirmed pushed into `part` or `blocked` instead of `unverified`; a stage given generously.",
    "",
    "The lanes, in the board's order, with what to mind for each:",
    "",
  );
  for (const lane of d.lanes) {
    const about = lane.about === undefined ? "" : `: ${displayPath(lane.about)}`;
    line(`- \`${lane.id}\` ${displayPath(lane.name)}${about}`);
    for (const note of lane.notes ?? []) line(`  - mind: ${displayPath(note)}`);
  }
  line("");
}

// What an observation's source says: the command, the page, or the operator.
function sourceOf(o: BoardObserve): string {
  switch (o.kind) {
    case "npm_version":
      return `npm view ${o.package} version`;
    case "github_release":
      return `gh release view --repo ${o.repo}`;
    case "github_open_issues":
      return `gh issue list --repo ${o.repo} --state open`;
    case "github_open_prs":
      return `gh pr list --repo ${o.repo} --state open`;
    case "github_ci":
      return `gh run list --repo ${o.repo} --workflow ${o.workflow} --branch ${o.branch}`;
    case "page_version":
      return o.url;
    case "manual":
      return "the operator";
  }
}

// The record's input to fill in: the previous record's cells beside each
// (null where it has none), or no `previous` with no previous record.
function templateOf(d: BoardDeclaration, previous: BoardPreviousRecords): string {
  const before = new Map<string, { state: string; reason?: string }>();
  if (previous.last.status === "found") {
    for (const cell of previous.last.record.cells) {
      const reason = (cell as { reason?: unknown }).reason;
      before.set(`${cell.lane}\0${cell.stage}`, {
        state: cell.state,
        ...(typeof reason === "string" ? { reason } : {}),
      });
    }
  }
  const observed = d.observe.map(
    (o) =>
      `    ${jsonText(o.key)}: ${jsonText({ value: null, observed_at: "", source: sourceOf(o) })}`,
  );
  const cells = d.lanes.flatMap((lane) =>
    BOARD_STAGE_IDS.map((stage) => {
      const cell =
        previous.last.status === "found"
          ? {
              lane: lane.id,
              stage,
              state: "",
              previous: before.get(`${lane.id}\0${stage}`) ?? null,
            }
          : { lane: lane.id, stage, state: "" };
      return `    ${jsonText(cell)}`;
    }),
  );
  return [
    "{",
    '  "measure_digest": "",',
    `  "observed": {${observed.length === 0 ? "}," : `\n${observed.join(",\n")}\n  },`}`,
    `  "cells": [\n${cells.join(",\n")}\n  ],`,
    '  "prose": {',
    '    "summary": "",',
    '    "lanes": {},',
    '    "operator_turns": [],',
    '    "footnotes": []',
    "  },",
    '  "judged_by": { "model": "", "self_reported": true },',
    '  "axis_review": null',
    "}",
  ].join("\n");
}

// What the guide says when no board is declared yet.
function undeclared(
  input: BoardGuideInput,
  go: string,
  line: (...lines: string[]) => void,
  block: (...lines: string[]) => void,
): void {
  line(
    "## No board is declared yet",
    "",
    `This workspace (${displayPath(input.anchor)}) declares no board at board/board.yaml. \`basou view\`'s /board page already draws what can be measured without one (the period and effort, the repos, the trail, the components). A judged board (the reach matrix, the lanes, the operator's turns) needs a declaration first.`,
    "",
    "1. Check that no one outside can read this repo: records hold what the trail holds (open tracks, time worked, model names). Step 9 (f) of this guide, once a board is declared, says how; on GitHub it is visibility PRIVATE, no collaborator but the owner and no invitation. Never keep a board in a repo shared with a client.",
    "2. Print a board to start from, and save it only where no board is. Never print it straight into board/board.yaml: the shell empties that file before init runs.",
  );
  block(`${go} && ${BOARD_INIT_SAVE}; echo "exit=$?"`);
  line(
    "3. Cut the axis, with the operator. The board asks what can be used now and what is stuck, not what was built. Replace the sample lane with lanes cut by who uses what, not by repo. Fix what each of the six stages means for this product, keeping 04 (merged) apart from 05 (in users' hands): merged but closed to users is used by no one. Declare under `observe` what is reached outside the repos (a registry, a release, a site). Measures, ratios and components may stay empty at first.",
    "4. Check it until it reads (every problem with it is listed at once):",
  );
  block(`${go} && basou board measure --model "$MODEL" > "$W/measure.txt"; echo "exit=$?"`);
  line(
    '5. Register the components: at first every component the markers find is unacknowledged, and the axis review (a) fires. Give each the lanes it counts in, or `"-"` with a note saying why it counts in none.',
    "6. Run `basou board guide` again: with a board declared, it prints the steps that judge and record it. The first record is the first review of the axis: give it an `axis_review`.",
    "",
  );
}
