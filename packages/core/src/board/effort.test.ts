import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { effortStartOf, measureEffort } from "./effort.js";

let root: string;
let paths: BasouPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basou-board-effort-"));
  paths = await ensureBasouDirectory(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

// The real method, taken before any test spies on it. Vitest 4 hands back the
// spy already in place, so one taken inside hostZoneIs would call itself.
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

// This host's zone, as `Intl` would name it under an empty or unknown TZ.
function hostZoneIs(name: string | undefined): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    const options = realResolvedOptions.call(this);
    return { ...options, timeZone: name as string };
  });
}

const input = (timeZone?: string) => ({
  paths,
  now: new Date("2026-10-05T03:00:00.000Z"),
  start: "2026-10-01",
  ...(timeZone === undefined ? {} : { timeZone }),
  repos: ["app"],
  authorDates: new Map([["app", { ok: true as const, dates: ["2026-10-02T00:00:00Z"] }]]),
});

describe("measureEffort", () => {
  it.each<[string | undefined, string]>([
    ["Etc/Unknown", "a name it gives back but does not take"],
    [undefined, "no name"],
  ])(
    "measures nothing when this host's time zone is %s (%s) and none is declared",
    async (name) => {
      hostZoneIs(name);
      const { effort, notFound } = await measureEffort(input());
      expect(effort).toEqual({
        start: "2026-10-01",
        time_zone: null,
        elapsed_days: null,
        active_ms: { union: null, claude: null, codex: null },
        output_tokens: null,
        sessions_without_tokens: null,
        commits: null,
        daily: null,
      });
      expect(notFound).toEqual([
        {
          at: "effort",
          reason:
            "this host's time zone could not be named, so the days are not known (declare effort.time_zone)",
        },
      ]);
    },
  );

  it("measures by a declared time zone whatever this host's is", async () => {
    const { effort, notFound } = await measureEffort(input("Asia/Tokyo"));
    expect(effort.time_zone).toBe("Asia/Tokyo");
    expect(effort.commits).toEqual({ app: 1 });
    expect(notFound).toEqual([]);
  });
});

describe("measureEffort with no declared start", () => {
  const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s}`;

  // A session that started at `startedAt`, with no events.
  async function placeStarted(id: string, startedAt: string): Promise<void> {
    const dir = join(paths.sessions, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "session.yaml"),
      stringify({
        schema_version: "0.1.0",
        session: {
          id,
          label: "fixture",
          task_id: null,
          workspace_id: "ws_01HXABCDEF1234567890ABCDEF",
          source: { kind: "terminal", version: "0.1.0" },
          started_at: startedAt,
          status: "completed",
          working_directory: "/tmp/fixture",
          invocation: { command: "echo", args: [], exit_code: 0 },
          related_files: [],
          events_log: "events.jsonl",
        },
      }),
    );
    await writeFile(join(dir, "events.jsonl"), "");
  }

  const undeclared = () => {
    const { start: _declared, ...rest } = input("Asia/Tokyo");
    return rest;
  };

  it("starts on the day the first session started, in the section's time zone", async () => {
    await placeStarted(SES("S02"), "2026-09-25T00:00:00Z");
    // 08:30 on 2026-09-21 in Tokyo, though 2026-09-20 in UTC.
    await placeStarted(SES("S01"), "2026-09-20T23:30:00Z");
    const { effort, notFound } = await measureEffort(undeclared());
    expect(effort.start).toBe("2026-09-21");
    expect(effort.elapsed_days).toBe(14);
    expect(effort.daily?.map((d) => d.date)).toHaveLength(15);
    expect(effort.daily?.[0]?.date).toBe("2026-09-21");
    expect(notFound).toEqual([]);
  });

  it("starts today when there is no session", async () => {
    const { effort, notFound } = await measureEffort(undeclared());
    expect(effort.start).toBe("2026-10-05");
    expect(effort.elapsed_days).toBe(0);
    expect(effort.daily?.map((d) => d.date)).toEqual(["2026-10-05"]);
    expect(notFound).toEqual([]);
  });

  it("starts today, and says so, when the sessions cannot be read", async () => {
    await placeStarted(SES("S01"), "2026-09-20T00:00:00Z");
    await writeFile(join(paths.sessions, SES("S01"), "session.yaml"), "session: [broken]\n");
    const { effort, notFound } = await measureEffort(undeclared());
    expect(effort.start).toBe("2026-10-05");
    expect(effort.active_ms).toEqual({ union: null, claude: null, codex: null });
    expect(notFound.map((n) => n.at)).toEqual([
      "effort.start",
      "effort.active_ms",
      "effort.output_tokens",
    ]);
    expect(notFound[0]?.reason).toBe(
      "the first session is not known, so the days are counted from today",
    );
  });

  it("names today in UTC as its start when this host's zone has no name, measuring nothing", async () => {
    await placeStarted(SES("S01"), "2026-09-20T00:00:00Z");
    hostZoneIs(undefined);
    const { start: _declared, timeZone: _zone, ...rest } = input("Asia/Tokyo");
    const { effort, notFound } = await measureEffort(rest);
    expect(effort.start).toBe("2026-10-05");
    expect(effort.daily).toBeNull();
    expect(notFound.map((n) => n.at)).toEqual(["effort"]);
  });

  it("never starts after today, whatever a session's clock said", async () => {
    await placeStarted(SES("S01"), "2026-12-01T00:00:00Z");
    const { effort, notFound } = await measureEffort(undeclared());
    expect(effort.start).toBe("2026-10-05");
    expect(effort.daily?.map((d) => d.date)).toEqual(["2026-10-05"]);
    expect(notFound).toEqual([]);
  });

  it("keeps a declared start, before or after the first session", async () => {
    await placeStarted(SES("S01"), "2026-09-20T00:00:00Z");
    expect((await measureEffort(input("Asia/Tokyo"))).effort.start).toBe("2026-10-01");
  });
  it("gives a board's start the same day, in this host's zone, and the zone", async () => {
    hostZoneIs("Asia/Tokyo");
    const now = new Date("2026-10-05T03:00:00.000Z");
    expect(await effortStartOf(paths, now)).toEqual({
      start: "2026-10-05",
      timeZone: "Asia/Tokyo",
      sessionsRead: true,
    });
    await placeStarted(SES("S02"), "2026-09-25T00:00:00Z");
    await placeStarted(SES("S01"), "2026-09-20T23:30:00Z");
    expect(await effortStartOf(paths, now)).toEqual({
      start: "2026-09-21",
      timeZone: "Asia/Tokyo",
      sessionsRead: true,
    });
    await writeFile(join(paths.sessions, SES("S01"), "session.yaml"), "session: [broken]\n");
    expect(await effortStartOf(paths, now)).toEqual({
      start: "2026-10-05",
      timeZone: "Asia/Tokyo",
      sessionsRead: false,
    });
    hostZoneIs(undefined);
    expect(await effortStartOf(paths, new Date("2026-10-05T23:00:00.000Z"))).toEqual({
      start: "2026-10-05",
      timeZone: undefined,
      sessionsRead: false,
    });
  });
});
