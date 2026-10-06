import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { measureEffort } from "./effort.js";

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

// This host's zone, as `Intl` would name it under an empty or unknown TZ.
function hostZoneIs(name: string | undefined): void {
  const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    const options = resolved.call(this);
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
