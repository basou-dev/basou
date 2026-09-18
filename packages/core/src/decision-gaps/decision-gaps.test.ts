import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { LOCAL_CLI_EVENT_SOURCE } from "../schemas/shared.schema.js";
import { type BasouPaths, basouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { ARCHIVE_DIR_NAME } from "../storage/tasks.js";
import {
  countOpenDecisionGaps,
  DECISION_GAPS_EPOCH,
  type DecisionForGapCount,
  findDecisionGaps,
} from "./decision-gaps.js";

const WS = "ws_01HXABCDEF1234567890ABCDEF";
const NOW = "2026-06-01T00:00:00.000Z";
const START = "2026-05-01T00:00:00.000Z";

/** Crockford base32 excludes I, L, O and U; an id containing one is skipped as malformed. */
function suffix(s: string): string {
  if (/[ILOU]/u.test(s)) throw new Error(`fixture id '${s}' uses a non-ULID character`);
  return s.padStart(3, "0");
}
const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${suffix(s)}`;
const DEC = (s: string): string => `decision_01HXABCDEF1234567890ABC${suffix(s)}`;
const TASK = (s: string): string => `task_01HXABCDEF1234567890ABC${suffix(s)}`;

let workDir: string | undefined;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-dg-test-"));
});
afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});
function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

let evtSeq = 0;
function evtId(): string {
  evtSeq += 1;
  return `evt_01HXABCDEF1234567890AB${String(evtSeq).padStart(4, "0")}`;
}

type DecisionFixture = {
  id: string;
  at: string;
  title?: string;
  source?: string;
  kind?: "decision" | "track";
};

function decisionLine(sessionId: string, d: DecisionFixture): string {
  return JSON.stringify({
    schema_version: "0.3.0",
    id: evtId(),
    session_id: sessionId,
    occurred_at: d.at,
    source: d.source ?? LOCAL_CLI_EVENT_SOURCE,
    type: "decision_recorded",
    decision_id: d.id,
    title: d.title ?? `decision ${d.id.slice(-3)}`,
    ...(d.kind !== undefined ? { kind: d.kind } : {}),
  });
}

function voidLine(sessionId: string, decisionId: string, at: string): string {
  return JSON.stringify({
    schema_version: "0.3.0",
    id: evtId(),
    session_id: sessionId,
    occurred_at: at,
    source: LOCAL_CLI_EVENT_SOURCE,
    type: "decision_voided",
    decision_id: decisionId,
  });
}

function sessionYaml(sessionId: string, status = "completed"): string {
  return stringify({
    schema_version: "0.1.0",
    session: {
      id: sessionId,
      label: `fixture ${sessionId.slice(-3)}`,
      task_id: null,
      workspace_id: WS,
      source: { kind: "human", version: "0.1.0" },
      started_at: START,
      status,
      working_directory: "/tmp/fixture",
      invocation: { command: "basou", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
}

async function placeSession(
  paths: BasouPaths,
  sessionId: string,
  eventLines: string[],
  opts: { status?: string } = {},
): Promise<string> {
  const dir = join(paths.sessions, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.yaml"), sessionYaml(sessionId, opts.status));
  await writeFile(join(dir, "events.jsonl"), `${eventLines.join("\n")}\n`);
  return dir;
}

/** Write a task file whose body mentions `mentions`, live or archived. */
async function placeTask(
  paths: BasouPaths,
  taskId: string,
  mentions: string,
  opts: { archived?: boolean } = {},
): Promise<string> {
  const dir = opts.archived === true ? join(paths.tasks, ARCHIVE_DIR_NAME) : paths.tasks;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${taskId}.md`);
  await writeFile(
    file,
    [
      "---",
      stringify({
        schema_version: "0.2.0",
        task: {
          id: taskId,
          title: `task ${taskId.slice(-3)}`,
          status: "planned",
          created_at: START,
          updated_at: START,
          workspace_id: WS,
          created_in_session: SES("1"),
          linked_sessions: [],
        },
      }).trimEnd(),
      "---",
      `Follows from ${mentions}.`,
      "",
    ].join("\n"),
  );
  return file;
}

async function setup(): Promise<BasouPaths> {
  const paths = basouPaths(getWorkDir());
  await ensureBasouDirectory(getWorkDir());
  await mkdir(paths.tasks, { recursive: true });
  return paths;
}

const run = (
  paths: BasouPaths,
  over: { start?: string; limit?: number } = {},
): ReturnType<typeof findDecisionGaps> =>
  findDecisionGaps({ paths, nowIso: NOW, start: START, ...over });

describe("findDecisionGaps", () => {
  it("lists a decision no task carries and omits one a task does", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-05-03T00:00:00.000Z" }),
    ]);
    await placeTask(paths, TASK("1"), DEC("2"));

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("1")]);
    expect(s.carried).toBe(1);
    expect(s.populationCount).toBe(2);
  });

  it("excludes decisions recorded before the start, inclusively", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-04-30T23:59:59.000Z" }),
      decisionLine(SES("1"), { id: DEC("2"), at: START }),
    ]);

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("2")]);
    expect(s.excluded.byStart).toBe(1);
  });

  it("compares the start as an instant, not as text", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      // 11:00Z — one hour BEFORE a midnight-Z start, but lexically after it.
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-01T20:00:00+09:00" }),
      // 14:00Z on the 2nd — after the start, but lexically before it.
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-05-02T05:00:00-09:00" }),
    ]);

    const s = await run(paths, { start: "2026-05-01T12:00:00.000Z" });
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("2")]);
    expect(s.excluded.byStart).toBe(1);
  });

  it("excludes decisions an importer derived, keeping only `basou decision capture`", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
      decisionLine(SES("1"), {
        id: DEC("2"),
        at: "2026-05-03T00:00:00.000Z",
        source: "claude-code-import",
      }),
    ]);

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("1")]);
    expect(s.excluded.bySource).toBe(1);
    expect(s.populationCount).toBe(1);
  });

  it("excludes a track — orient already resurfaces it every session", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z", kind: "track" }),
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-05-03T00:00:00.000Z" }),
    ]);

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("2")]);
    expect(s.excluded.track).toBe(1);
    expect(s.populationCount).toBe(1);
  });

  it("drains a decision closed with `decision void`, even from a later session", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-05-03T00:00:00.000Z" }),
    ]);
    // Voiding is a separate `basou decision void` run, so its event normally
    // lands in a session later than the one that recorded the decision.
    await placeSession(paths, SES("2"), [voidLine(SES("2"), DEC("2"), "2026-05-04T00:00:00.000Z")]);

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("1")]);
    expect(s.excluded.voided).toBe(1);
  });

  it("counts a voided track once, under the first ground that excludes it", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z", kind: "track" }),
      voidLine(SES("1"), DEC("1"), "2026-05-03T00:00:00.000Z"),
    ]);

    const s = await run(paths);
    // The four grounds partition: 1 + 0, not 1 + 1.
    expect(s.excluded.track).toBe(1);
    expect(s.excluded.voided).toBe(0);
    expect(s.populationCount).toBe(0);
  });

  it("counts each decision once even when its id was recorded more than once", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-04-01T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);

    const s = await run(paths);
    // One decision, in scope. It must not ALSO appear under `byStart` — the
    // counters and the population share a denominator.
    expect(s.populationCount).toBe(1);
    expect(s.excluded.byStart).toBe(0);
    expect(s.gaps[0]?.recordedAt).toBe("2026-05-02T00:00:00.000Z");
  });

  it("counts a reference from an archived task", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    await placeTask(paths, TASK("1"), DEC("1"), { archived: true });

    const s = await run(paths);
    // Archiving records that work finished; it must not un-carry a decision.
    expect(s.gaps).toEqual([]);
    expect(s.carried).toBe(1);
    expect(s.tasksScanned).toBe(1);
  });

  it("counts a reference from a task whose front matter does not parse", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    await writeFile(join(paths.tasks, `${TASK("1")}.md`), `not front matter at all\n${DEC("1")}\n`);

    const s = await run(paths);
    expect(s.gaps).toEqual([]);
    expect(s.carried).toBe(1);
  });

  it("follows a symlinked task file instead of silently skipping it", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    const real = join(getWorkDir(), "elsewhere.md");
    await writeFile(real, `covers ${DEC("1")}\n`);
    await symlink(real, join(paths.tasks, `${TASK("1")}.md`));

    const s = await run(paths);
    expect(s.gaps).toEqual([]);
    expect(s.carried).toBe(1);
    expect(s.tasksScanned).toBe(1);
  });

  it("does not call a task's reference to an out-of-scope decision unknown", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
      // Recorded before the start, so out of the population — but it IS a
      // decision this store has, and a task naming it is not naming a ghost.
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-04-01T00:00:00.000Z" }),
    ]);
    await placeTask(paths, TASK("1"), DEC("2"));

    const s = await run(paths);
    expect(s.incomplete.unknownReferences).toBe(0);
    expect(s.excluded.byStart).toBe(1);
  });

  it("does not let a markdown file that is not a task carry a decision", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    await writeFile(join(paths.tasks, "scratch-notes.md"), `maybe ${DEC("1")} someday, or not\n`);

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("1")]);
    expect(s.tasksScanned).toBe(0);
  });

  it("does not let an id no decision has take a decision off the list", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    // A well-formed id that nothing ever recorded — a hand-typed string, or a
    // fixture. It must not read as coverage.
    await placeTask(paths, TASK("1"), DEC("9"));

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("1")]);
    expect(s.carried).toBe(0);
    expect(s.incomplete.unknownReferences).toBe(1);
  });

  it("does not match an abbreviated or an over-long decision reference", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-05-03T00:00:00.000Z" }),
    ]);
    await placeTask(paths, TASK("1"), `${DEC("1").slice(0, 20)}...${DEC("1").slice(-3)}`);
    // An over-long token must not match on its 26-character prefix: that would
    // take a real decision off the list, which is the fail-OPEN direction.
    await placeTask(paths, TASK("2"), `${DEC("2")}XYZ`);

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId).sort()).toEqual([DEC("1"), DEC("2")]);
    expect(s.carried).toBe(0);
  });

  it("reports an unreadable task file instead of silently dropping its references", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    const file = await placeTask(paths, TASK("1"), DEC("1"));
    await chmod(file, 0o000);

    try {
      const s = await run(paths);
      expect(s.incomplete.tasks).toBe(1);
      expect(s.tasksScanned).toBe(0);
      expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("1")]);
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("reports a session it could not read, rather than answering as if it were empty", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    await mkdir(join(paths.sessions, SES("2")), { recursive: true });
    await writeFile(join(paths.sessions, SES("2"), "session.yaml"), "not: [valid");

    const s = await run(paths);
    // Without this count, a store whose sessions could not be read is
    // indistinguishable from one that holds nothing.
    expect(s.incomplete.sessions).toBe(1);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("1")]);
  });

  it("keeps reporting when one session's events.jsonl cannot be read", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    const dir2 = await placeSession(paths, SES("2"), [
      decisionLine(SES("2"), { id: DEC("2"), at: "2026-05-03T00:00:00.000Z" }),
    ]);
    const log = join(dir2, "events.jsonl");
    await chmod(log, 0o000);

    try {
      const skips: string[] = [];
      const s = await findDecisionGaps({
        paths,
        nowIso: NOW,
        start: START,
        onSessionSkip: (sid, reason) => skips.push(`${sid}:${reason}`),
      });
      // The readable session's decision still reaches the report.
      expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("1")]);
      expect(s.incomplete.sessions).toBe(1);
      expect(skips).toEqual([`${SES("2")}:events_jsonl_unreadable`]);
    } finally {
      await chmod(log, 0o600);
    }
  });

  it("counts a session it could not read once, however many ways it failed", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);
    // `running`: the loader reports the unreadable log AND still returns the
    // entry, whose replay then fails too. Counting both would double the number
    // the report states about what it could not read.
    const dir2 = await placeSession(paths, SES("2"), ["{}"], { status: "running" });
    await chmod(join(dir2, "events.jsonl"), 0o000);

    try {
      const s = await run(paths);
      expect(s.incomplete.sessions).toBe(1);
    } finally {
      await chmod(join(dir2, "events.jsonl"), 0o600);
    }
  });

  it("caps the list at `limit` and counts the rest", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-05-03T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("3"), at: "2026-05-04T00:00:00.000Z" }),
    ]);

    const s = await run(paths, { limit: 2 });
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("3"), DEC("2")]);
    expect(s.truncated).toBe(1);
    // The population is what was checked, not what was shown.
    expect(s.populationCount).toBe(3);
  });

  it("orders gaps newest first, breaking ties by decision id descending", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("3"), at: "2026-05-05T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-05-05T00:00:00.000Z" }),
    ]);

    const s = await run(paths);
    expect(s.gaps.map((g) => g.decisionId)).toEqual([DEC("3"), DEC("2"), DEC("1")]);
  });

  it("emits each replay warning once, not once per pass", async () => {
    const paths = await setup();
    // `running`, deliberately: `loadSessionEntries` replays a running session to
    // classify it and a completed one not at all, so a completed fixture cannot
    // enter the double-emission path and the assertion would hold either way.
    await placeSession(
      paths,
      SES("1"),
      ["{not json", decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" })],
      { status: "running" },
    );

    const warnings: string[] = [];
    await findDecisionGaps({
      paths,
      nowIso: NOW,
      start: START,
      onWarning: (w, sid) => warnings.push(`${sid}:${w.kind}`),
    });
    expect(warnings).toEqual([`${SES("1")}:malformed_json`]);
  });

  it("reports an empty population on a workspace with no decisions in scope", async () => {
    const paths = await setup();
    const s = await run(paths);
    expect(s.populationCount).toBe(0);
    expect(s.gaps).toEqual([]);
    expect(s.scope).toEqual({ start: START, source: LOCAL_CLI_EVENT_SOURCE });
    expect(s.incomplete).toEqual({ sessions: 0, tasks: 0, unknownReferences: 0 });
  });

  it("defaults the start to DECISION_GAPS_EPOCH when the caller passes none", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
    ]);

    const s = await findDecisionGaps({ paths, nowIso: NOW });
    expect(s.scope.start).toBe(DECISION_GAPS_EPOCH);
    // The fixture's hardcoded 2026-05-02 is before the shipped epoch, so this
    // fails if the constant ever moves back past it — an anchor independent of
    // the constant itself.
    expect(s.gaps).toEqual([]);
    expect(s.excluded.byStart).toBe(1);
  });

  it("rejects a start that is not a timestamp rather than silently admitting everything", async () => {
    const paths = await setup();
    await expect(findDecisionGaps({ paths, nowIso: NOW, start: "last tuesday" })).rejects.toThrow(
      /Invalid start timestamp/u,
    );
  });
});

/**
 * `countOpenDecisionGaps` exists so `basou orient` can state the number without
 * a second full replay, and `orient` names `basou decision gaps` on the same
 * line. If the two answer differently, one surface of the product contradicts
 * another, and nothing in the types prevents it — so they are pinned here
 * against a matrix of the cases where they could diverge.
 */
describe("countOpenDecisionGaps agrees with findDecisionGaps", () => {
  const cases: Array<{ name: string; events: DecisionFixture[]; voids?: string[] }> = [
    { name: "a plain open decision", events: [{ id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }] },
    {
      name: "one before the start",
      events: [{ id: DEC("1"), at: "2026-04-01T00:00:00.000Z" }],
    },
    {
      name: "one from an importer",
      events: [{ id: DEC("1"), at: "2026-05-02T00:00:00.000Z", source: "claude-code-import" }],
    },
    {
      name: "a track",
      events: [{ id: DEC("1"), at: "2026-05-02T00:00:00.000Z", kind: "track" }],
    },
    {
      name: "a decision later re-recorded AS a track",
      events: [
        { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" },
        { id: DEC("1"), at: "2026-05-03T00:00:00.000Z", kind: "track" },
      ],
    },
    {
      name: "a track later re-recorded as a plain decision",
      events: [
        { id: DEC("1"), at: "2026-05-02T00:00:00.000Z", kind: "track" },
        { id: DEC("1"), at: "2026-05-03T00:00:00.000Z" },
      ],
    },
    {
      name: "an id straddling the start boundary",
      events: [
        { id: DEC("1"), at: "2026-04-01T00:00:00.000Z" },
        { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" },
      ],
    },
    {
      name: "an id whose later event came from an importer",
      events: [
        { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" },
        { id: DEC("1"), at: "2026-05-03T00:00:00.000Z", source: "claude-code-import" },
      ],
    },
    {
      name: "a voided decision",
      events: [{ id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }],
      voids: [DEC("1")],
    },
    {
      name: "several at once",
      events: [
        { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" },
        { id: DEC("2"), at: "2026-05-03T00:00:00.000Z", kind: "track" },
        { id: DEC("3"), at: "2026-05-04T00:00:00.000Z" },
        { id: DEC("4"), at: "2026-04-01T00:00:00.000Z" },
      ],
      voids: [DEC("3")],
    },
  ];

  for (const c of cases) {
    it(`agrees on ${c.name}`, async () => {
      const paths = await setup();
      await placeSession(paths, SES("1"), [
        ...c.events.map((e) => decisionLine(SES("1"), e)),
        ...(c.voids ?? []).map((id) => voidLine(SES("1"), id, "2026-05-09T00:00:00.000Z")),
      ]);

      const viaCommand = await run(paths);
      // The orient path's inputs, built the way the orientation renderer builds
      // them — from the same events, independently of the command's own pass.
      const decisions: DecisionForGapCount[] = c.events.map((e) => ({
        decisionId: e.id,
        occurredAt: e.at,
        source: e.source ?? LOCAL_CLI_EVENT_SOURCE,
        kind: e.kind,
      }));
      const viaOrient = await countOpenDecisionGaps({
        paths,
        decisions,
        voidedDecisionIds: new Set(c.voids ?? []),
        start: START,
      });
      expect(viaOrient).toBe(viaCommand.gaps.length + viaCommand.truncated);
    });
  }

  it("agrees when a task carries one of them", async () => {
    const paths = await setup();
    await placeSession(paths, SES("1"), [
      decisionLine(SES("1"), { id: DEC("1"), at: "2026-05-02T00:00:00.000Z" }),
      decisionLine(SES("1"), { id: DEC("2"), at: "2026-05-03T00:00:00.000Z" }),
    ]);
    await placeTask(paths, TASK("1"), DEC("2"));

    const viaCommand = await run(paths);
    const viaOrient = await countOpenDecisionGaps({
      paths,
      decisions: [
        {
          decisionId: DEC("1"),
          occurredAt: "2026-05-02T00:00:00.000Z",
          source: LOCAL_CLI_EVENT_SOURCE,
          kind: undefined,
        },
        {
          decisionId: DEC("2"),
          occurredAt: "2026-05-03T00:00:00.000Z",
          source: LOCAL_CLI_EVENT_SOURCE,
          kind: undefined,
        },
      ],
      voidedDecisionIds: new Set(),
      start: START,
    });
    expect(viaOrient).toBe(1);
    expect(viaOrient).toBe(viaCommand.gaps.length + viaCommand.truncated);
  });
});
