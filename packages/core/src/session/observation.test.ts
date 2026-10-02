import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  observedFileFrom,
  observedFilesOf,
  readSessionObservation,
  SESSION_OBSERVATION_SCHEMA_VERSION,
  type SessionObservation,
  sessionObservationPath,
  writeSessionObservation,
} from "./observation.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-observation-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function observation(overrides: Partial<SessionObservation> = {}): SessionObservation {
  return {
    schema_version: SESSION_OBSERVATION_SCHEMA_VERSION,
    external_id: "d9630a63-54c1-47d0-bc6f-8d840446433e",
    started_at: "2026-09-22T10:00:00.000Z",
    updated_at: "2026-09-22T10:30:00.000Z",
    repos: [
      {
        path: "/repo",
        base_head: "a".repeat(40),
        base_dirty: [],
        files: [{ path: "/repo/src/a.ts", change_type: "modified" }],
      },
    ],
    ...overrides,
  };
}

describe("sessionObservationPath", () => {
  it("names a file inside the directory for an ordinary vendor id", () => {
    expect(sessionObservationPath(dir, "abc-123_ID.4")).toBe(join(dir, "abc-123_ID.4.json"));
  });

  it.each([
    ["a separator", "a/b"],
    ["a parent segment", ".."],
    ["a leading dot", ".hidden"],
    ["an absolute path", "/etc/passwd"],
    ["an empty id", ""],
    ["a control character", `a${String.fromCharCode(0)}b`],
    ["an id longer than the cap", "a".repeat(129)],
  ])("refuses %s rather than escaping it", (_label, id) => {
    expect(sessionObservationPath(dir, id)).toBeNull();
  });
});

describe("readSessionObservation", () => {
  it("round-trips what was written", async () => {
    const written = observation();
    await writeSessionObservation(dir, written);
    expect(await readSessionObservation(dir, written.external_id)).toEqual(written);
  });

  it("returns null when nothing was written", async () => {
    expect(await readSessionObservation(dir, "missing-id")).toBeNull();
  });

  it("returns null for an unsafe id without touching disk", async () => {
    expect(await readSessionObservation(dir, "../escape")).toBeNull();
  });

  it("returns null for malformed JSON rather than throwing", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "broken.json"), "{ not json");
    expect(await readSessionObservation(dir, "broken")).toBeNull();
  });

  it("returns null for a shape it cannot trust", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "wrong.json"), JSON.stringify({ external_id: 42 }));
    expect(await readSessionObservation(dir, "wrong")).toBeNull();
  });

  it("returns null for a version it does not understand", async () => {
    await writeSessionObservation(dir, observation({ schema_version: "9.9.9" }));
    expect(await readSessionObservation(dir, observation().external_id)).toBeNull();
  });
});

describe("writeSessionObservation", () => {
  it("creates the directory, so a store initialized before observations still works", async () => {
    const nested = join(dir, "deep", "observations");
    await writeSessionObservation(nested, observation());
    expect(await readSessionObservation(nested, observation().external_id)).not.toBeNull();
  });

  it("writes nothing for an unsafe id", async () => {
    await writeSessionObservation(dir, observation({ external_id: "../escape" }));
    await expect(readFile(join(dir, "..", "escape.json"), "utf8")).rejects.toThrow();
  });
});

describe("observedFilesOf", () => {
  it("flattens every repository into one path-ordered list", () => {
    const flat = observedFilesOf(
      observation({
        repos: [
          {
            path: "/b",
            base_head: null,
            base_dirty: [],
            files: [{ path: "/b/z.ts", change_type: "added" }],
          },
          {
            path: "/a",
            base_head: null,
            base_dirty: [],
            files: [{ path: "/a/y.ts", change_type: "deleted" }],
          },
        ],
      }),
    );
    expect(flat.map((f) => f.path)).toEqual(["/a/y.ts", "/b/z.ts"]);
  });
});

describe("observedFileFrom", () => {
  it("makes the repo-relative path absolute, old path included", () => {
    expect(
      observedFileFrom("/repo", { path: "b.ts", status: "renamed", old_path: "a.ts" }),
    ).toEqual({ path: "/repo/b.ts", change_type: "renamed", old_path: "/repo/a.ts" });
  });
});

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")(
  "an observations directory that is not followed",
  () => {
    /** `<dir>/store/.basou/tmp/observations`, as `basouPaths` lays it out. */
    function observationsUnder(): { tmp: string; observations: string } {
      const tmp = join(dir, "store", ".basou", "tmp");
      return { tmp, observations: join(tmp, "observations") };
    }

    it("control: writes and reads under a real .basou/tmp", async () => {
      const { tmp, observations } = observationsUnder();
      await mkdir(tmp, { recursive: true });
      await writeSessionObservation(observations, observation());
      expect(await readSessionObservation(observations, observation().external_id)).toEqual(
        observation(),
      );
    });

    for (const [label, linked] of [
      [".basou/tmp", "tmp"],
      [".basou/tmp/observations", "observations"],
    ] as const) {
      it(`writes nothing behind a ${label} that is a symlink, and reads nothing through it`, async () => {
        const layout = observationsUnder();
        await mkdir(layout.observations, { recursive: true });
        await writeSessionObservation(layout.observations, observation());
        const outside = join(dir, "outside");
        await rename(layout[linked], outside);
        await symlink(outside, layout[linked]);
        const before = await readdir(outside, { recursive: true });

        await expect(
          writeSessionObservation(layout.observations, observation({ external_id: "another-id" })),
        ).rejects.toThrow(new Error(`${label} is a symlink; refusing to operate`));
        expect(await readdir(outside, { recursive: true })).toEqual(before);
        expect(
          await readSessionObservation(layout.observations, observation().external_id),
        ).toBeNull();
      });
    }

    it("refuses a .basou/tmp that is a file", async () => {
      const { tmp, observations } = observationsUnder();
      await mkdir(join(tmp, ".."), { recursive: true });
      await writeFile(tmp, "");
      await expect(writeSessionObservation(observations, observation())).rejects.toThrow(
        new Error(".basou/tmp exists but is not a directory"),
      );
      expect(await readSessionObservation(observations, observation().external_id)).toBeNull();
    });

    it("reads nothing through an observation file that is a symlink", async () => {
      const { observations } = observationsUnder();
      await mkdir(observations, { recursive: true });
      const outside = join(dir, "outside.json");
      await writeFile(outside, `${JSON.stringify(observation())}\n`);
      await symlink(outside, join(observations, `${observation().external_id}.json`));
      expect(await readSessionObservation(observations, observation().external_id)).toBeNull();
      // A write replaces the link by rename rather than writing through it.
      await writeSessionObservation(
        observations,
        observation({ updated_at: "2026-09-22T11:00:00.000Z" }),
      );
      expect(JSON.parse(await readFile(outside, "utf8"))).toEqual(observation());
      expect(
        (await readSessionObservation(observations, observation().external_id))?.updated_at,
      ).toBe("2026-09-22T11:00:00.000Z");
    });
  },
);
