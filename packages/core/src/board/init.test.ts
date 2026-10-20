import { describe, expect, it } from "vitest";
import { boardInitStrings } from "../lib/view-strings.js";
import { BOARD_OBSERVE_KINDS, parseBoardDeclaration } from "./declaration.js";
import { BOARD_INIT_LANE_ID, boardInitText } from "./init.js";

const en = boardInitStrings("en");
const ja = boardInitStrings("ja");
const read = (text: string) => parseBoardDeclaration(text, { manifestRepoPaths: ["."] });

describe("boardInitText", () => {
  it("prints a declaration of the newest version that reads as it is", () => {
    const text = boardInitText({
      name: "shop",
      language: "en",
      start: "2026-09-21",
      startIsFirstSession: true,
      timeZone: "Asia/Tokyo",
    });
    const result = read(text);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const d = result.declaration;
    expect(d.board_version).toBe(3);
    expect(d.title).toBe("shop progress board");
    expect(Object.keys(d.stages)).toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(d.stages["04"].meaning).toBe(en.stages["04"]);
    expect(d.stages["05"].meaning).toBe(en.stages["05"]);
    expect(d.lanes.map((l) => l.id)).toEqual([BOARD_INIT_LANE_ID]);
    expect(d.observe).toEqual([]);
    expect(d.components).toEqual({});
    expect(d.measures).toEqual([]);
    expect(d.axis).toEqual({ version: 1, review_due_days: 60 });
    expect(d.effort).toEqual({ start: "2026-09-21", time_zone: "Asia/Tokyo", milestones: [] });
    expect(text.split("\n")[0]).toMatch(/^# A progress board, printed by `basou board init`\./);
  });

  it("says, above an empty measures, which measures the board page draws", () => {
    for (const [language, words] of [
      ["en", en],
      ["ja", ja],
    ] as const) {
      const text = boardInitText({
        name: "shop",
        language,
        start: "2026-09-21",
        startIsFirstSession: true,
        timeZone: "UTC",
      });
      expect(text).toContain(`# ${words.comments.measures}\nmeasures: []\n`);
    }
    expect(en.comments.measures).toContain(
      "Each is drawn in the board page's table of measures, and one with a lane, or a list of lanes, in each one's section of the page too.",
    );
    // The comment on observe names every kind a board can declare, http among them.
    for (const kind of BOARD_OBSERVE_KINDS) {
      expect(en.comments.observe).toContain(kind);
      expect(ja.comments.observe).toContain(kind);
    }
    // The comment on measures names every kind a board can declare, file_name, file_paths and total among them.
    for (const kind of [
      "file_count",
      "dir_count",
      "line_count",
      "match_count",
      "regex_capture",
      "json_length",
      "file_name",
      "file_paths",
      "trail_count",
      "total",
    ]) {
      expect(en.comments.measures).toContain(kind);
      expect(ja.comments.measures).toContain(kind);
    }
    expect(ja.comments.measures).toContain(
      "\u3069\u308c\u3082\u76e4\u306e\u30da\u30fc\u30b8\u306e measure \u306e\u4e00\u89a7\u306b\u63cf\u304b\u308c\u3001lane\uff081 \u3064\u306e\u30ec\u30fc\u30f3\u304b\u3001\u30ec\u30fc\u30f3\u306e\u4e26\u3073\uff09\u3092\u4ed8\u3051\u305f\u3082\u306e\u306f\u305d\u308c\u305e\u308c\u306e\u30ec\u30fc\u30f3\u306e\u7bc0\u306b\u3082\u63cf\u304b\u308c\u308b",
    );
  });

  it("says, above an empty components, that a directory no built-in marker finds takes a marker", () => {
    for (const [language, words] of [
      ["en", en],
      ["ja", ja],
    ] as const) {
      const text = boardInitText({
        name: "shop",
        language,
        start: "2026-09-21",
        startIsFirstSession: true,
        timeZone: "UTC",
      });
      expect(text).toContain(`# ${words.comments.components}\ncomponents: {}\n`);
    }
    expect(en.comments.components).toContain(
      "A directory no built-in marker finds (content, scripts) is registered with a marker: a glob, from it, of the files that mark it.",
    );
    expect(ja.comments.components).toContain(
      "marker\uff08\u305d\u306e\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u304b\u3089\u898b\u305f\u3001\u5370\u306b\u3059\u308b\u30d5\u30a1\u30a4\u30eb\u306e glob\uff09\u3092\u4ed8\u3051\u3066\u767b\u9332\u3059\u308b",
    );
  });

  it("writes the words in Japanese for a Japanese anchor", () => {
    const result = read(
      boardInitText({
        name: "shop",
        language: "ja",
        start: "2026-09-21",
        startIsFirstSession: true,
        timeZone: "UTC",
      }),
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.title).toBe(ja.title.replace("{name}", "shop"));
    expect(result.declaration.stages["05"].meaning).toBe(ja.stages["05"]);
    expect(ja.stages["05"]).not.toBe(en.stages["05"]);
  });

  it("leaves the time zone out, and says to write it, when this host's has no name", () => {
    const text = boardInitText({
      name: "shop",
      language: "en",
      start: "2026-10-05",
      startIsFirstSession: false,
      timeZone: undefined,
    });
    expect(text).toContain(`  # ${en.comments.timeZone}`);
    expect(text).toContain(`# ${en.comments.effortToday}\neffort:`);
    expect(text).not.toContain(en.comments.effort);
    const result = read(text);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.effort).toEqual({ start: "2026-10-05", milestones: [] });
  });

  it("says, above an empty milestones under the effort, what a milestone holds", () => {
    for (const [language, words] of [
      ["en", en],
      ["ja", ja],
    ] as const) {
      for (const timeZone of ["UTC", undefined]) {
        const text = boardInitText({
          name: "shop",
          language,
          start: "2026-09-21",
          startIsFirstSession: true,
          timeZone,
        });
        expect(text.endsWith(`  # ${words.comments.milestones}\n  milestones: []\n`)).toBe(true);
      }
    }
    expect(en.comments.milestones).toContain("{ date: YYYY-MM-DD, label, ref }");
    expect(en.comments.milestones).toContain(
      "A board moved from another keeps its milestones here.",
    );
    expect(ja.comments.milestones).toContain("{ date: YYYY-MM-DD, label, ref }");
    expect(ja.comments.milestones).toContain("他の盤から移すときは、その節目をここに移す。");
    expect(en.comments.milestones).toContain(
      "with ref saying where it can be checked (a tag and its commit, or a decision id in full)",
    );
    expect(ja.comments.milestones).toContain(
      "ref に確かめられる出所（tag とその commit、または完全な decision の ID）を書く。",
    );
  });

  it("keeps a name as written, whatever it holds", () => {
    const bidi = String.fromCodePoint(0x202e);
    const lines = (name: string) =>
      boardInitText({
        name,
        language: "en",
        start: "2026-10-05",
        startIsFirstSession: true,
        timeZone: "UTC",
      }).split("\n");
    for (const name of ['a "quoted" $& name', "it's #1: yes", "x\ny", `${bidi}x`]) {
      const text = lines(name).join("\n");
      const result = read(text);
      if (!result.ok) throw new Error(result.errors.join("\n"));
      expect(result.declaration.title).toBe(`${name} progress board`);
      // One line for the title, and nothing a terminal would act on.
      expect(lines(name)).toHaveLength(lines("plain").length);
      expect(text).not.toContain(bidi);
    }
  });
});
