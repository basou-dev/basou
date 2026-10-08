import { describe, expect, it } from "vitest";
import { boardInitStrings } from "../lib/view-strings.js";
import { parseBoardDeclaration } from "./declaration.js";
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
      timeZone: "Asia/Tokyo",
    });
    const result = read(text);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const d = result.declaration;
    expect(d.board_version).toBe(2);
    expect(d.title).toBe("shop progress board");
    expect(Object.keys(d.stages)).toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(d.stages["04"].meaning).toBe(en.stages["04"]);
    expect(d.stages["05"].meaning).toBe(en.stages["05"]);
    expect(d.lanes.map((l) => l.id)).toEqual([BOARD_INIT_LANE_ID]);
    expect(d.observe).toEqual([]);
    expect(d.components).toEqual({});
    expect(d.measures).toEqual([]);
    expect(d.axis).toEqual({ version: 1, review_due_days: 60 });
    expect(d.effort).toEqual({ start: "2026-09-21", time_zone: "Asia/Tokyo" });
    expect(text.split("\n")[0]).toMatch(/^# A progress board, printed by `basou board init`\./);
  });

  it("writes the words in Japanese for a Japanese anchor", () => {
    const result = read(
      boardInitText({ name: "shop", language: "ja", start: "2026-09-21", timeZone: "UTC" }),
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
      timeZone: undefined,
    });
    expect(text).toContain("  # This host's time zone has no name: write effort.time_zone");
    const result = read(text);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.declaration.effort).toEqual({ start: "2026-10-05" });
  });

  it("keeps a name as written, whatever it holds", () => {
    const bidi = String.fromCodePoint(0x202e);
    const lines = (name: string) =>
      boardInitText({ name, language: "en", start: "2026-10-05", timeZone: "UTC" }).split("\n");
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
