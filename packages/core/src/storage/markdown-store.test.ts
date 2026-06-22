import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GENERATED_END,
  GENERATED_START,
  PROTOCOL_END,
  PROTOCOL_START,
  parseMarkers,
  readMarkdownFile,
  removeMarkerSection,
  renderWithMarkers,
  writeMarkdownFile,
} from "./markdown-store.js";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-md-test-"));
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

describe("markdown-store", () => {
  describe("writeMarkdownFile", () => {
    it("case 1: writes a body atomically and leaves no tmp file behind", async () => {
      const filePath = join(getWorkDir(), "handoff.md");
      await writeMarkdownFile(filePath, "# hello\n");
      const body = await readFile(filePath, "utf8");
      expect(body).toBe("# hello\n");
      const entries = await readdir(getWorkDir());
      expect(entries).toEqual(["handoff.md"]);
    });

    it("case 2: cleans up the tmp file when writing fails (target is a directory)", async () => {
      // rename into a path that is already a directory fails with EISDIR.
      const target = join(getWorkDir(), "decisions.md");
      // Pre-create the path as a directory so rename fails.
      await import("node:fs/promises").then((m) => m.mkdir(target, { recursive: true }));
      await expect(writeMarkdownFile(target, "x")).rejects.toThrow("Failed to write markdown file");
      const entries = await readdir(getWorkDir());
      // Only the directory remains; no leftover tmp file.
      expect(entries).toEqual(["decisions.md"]);
    });
  });

  describe("readMarkdownFile", () => {
    it("case 3: returns null on ENOENT", async () => {
      const result = await readMarkdownFile(join(getWorkDir(), "missing.md"));
      expect(result).toBeNull();
    });

    it("case 4: throws pathless error on a non-ENOENT I/O failure (target is a directory)", async () => {
      const target = join(getWorkDir(), "dir.md");
      await import("node:fs/promises").then((m) => m.mkdir(target, { recursive: true }));
      await expect(readMarkdownFile(target)).rejects.toThrow("Failed to read markdown file");
    });
  });

  describe("parseMarkers", () => {
    it("case 5: ok — extracts before/generated/after with LF (generated has trailing \\n trimmed)", () => {
      // The trailing newline before END is stripped from `generated` by design,
      // so renderWithMarkers can normalize and re-append it cleanly.
      const body = `intro line\n${GENERATED_START}\nauto body\n${GENERATED_END}\ntrailer line\n`;
      const result = parseMarkers(body);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.before).toBe("intro line\n");
      expect(result.generated).toBe("auto body");
      expect(result.after).toBe("\ntrailer line\n");
    });

    it("case 6: no_markers — legacy file without either marker", () => {
      const result = parseMarkers("just some prose\n");
      expect(result).toEqual({ kind: "no_markers" });
    });

    it("case 7a: missing_start", () => {
      const result = parseMarkers(`prose\n${GENERATED_END}\n`);
      expect(result).toEqual({ kind: "missing_start" });
    });

    it("case 7b: missing_end", () => {
      const result = parseMarkers(`${GENERATED_START}\nbody\n`);
      expect(result).toEqual({ kind: "missing_end" });
    });

    it("case 8: multiple_pairs", () => {
      const body =
        `${GENERATED_START}\na\n${GENERATED_END}\nmid\n` +
        `${GENERATED_START}\nb\n${GENERATED_END}\n`;
      expect(parseMarkers(body)).toEqual({ kind: "multiple_pairs" });
    });

    it("case 9: wrong_order — END appears before START", () => {
      const body = `${GENERATED_END}\nbody\n${GENERATED_START}\n`;
      expect(parseMarkers(body)).toEqual({ kind: "wrong_order" });
    });

    it("case 14: CRLF line endings parse as ok and preserve surrounding text", () => {
      const body = `intro\r\n${GENERATED_START}\r\nauto\r\n${GENERATED_END}\r\ntail\r\n`;
      const result = parseMarkers(body);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.before).toBe("intro\r\n");
      expect(result.after).toBe("\r\ntail\r\n");
    });

    it("case 15a: leading whitespace on marker line is treated as legacy (no_markers)", () => {
      const body = ` ${GENERATED_START}\nbody\n ${GENERATED_END}\n`;
      expect(parseMarkers(body)).toEqual({ kind: "no_markers" });
    });

    it("case 15b: compressed comment form is treated as legacy (no_markers)", () => {
      const body = "<!--BASOU:GENERATED:START-->\nbody\n<!--BASOU:GENERATED:END-->\n";
      expect(parseMarkers(body)).toEqual({ kind: "no_markers" });
    });
  });

  describe("renderWithMarkers", () => {
    it("case 10: existing === null produces a fresh marker block", () => {
      const result = renderWithMarkers(null, "body content", "handoff.md");
      expect(result).toBe(`${GENERATED_START}\nbody content\n${GENERATED_END}\n`);
    });

    it("case 11: replaces the generated region and preserves before/after", () => {
      const original = `intro\n${GENERATED_START}\nold\n${GENERATED_END}\nmanual notes\n`;
      const next = renderWithMarkers(original, "new body", "handoff.md");
      expect(next).toBe(`intro\n${GENERATED_START}\nnew body\n${GENERATED_END}\nmanual notes\n`);
    });

    it("case 12: no_markers throws 'Markers missing in <fileLabel>'", () => {
      expect(() => renderWithMarkers("legacy file\n", "x", "handoff.md")).toThrow(
        "Markers missing in handoff.md",
      );
    });

    it("case 13: multiple_pairs throws 'Markers mismatched in <fileLabel>'", () => {
      const body = `${GENERATED_START}\na\n${GENERATED_END}\n${GENERATED_START}\nb\n${GENERATED_END}\n`;
      expect(() => renderWithMarkers(body, "x", "decisions.md")).toThrow(
        "Markers mismatched in decisions.md",
      );
    });
  });

  // A leading UTF-8 BOM is tolerated on the default (GENERATED) marker path,
  // which every generated-block writer (handoff/decisions/orient/preset) uses.
  // On a marker-on-first-line BOM file this previously fell through as
  // `no_markers` and renderWithMarkers would have duplicated the block; the
  // marker machinery now strips the BOM for matching and re-prepends it.
  describe("BOM handling (default GENERATED pair)", () => {
    const BOM = "\uFEFF";

    it("parseMarkers: a BOM before the START marker on line 0 still parses as ok and keeps the BOM in `before`", () => {
      const body = `${BOM}${GENERATED_START}\nauto\n${GENERATED_END}\ntail\n`;
      const result = parseMarkers(body);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.before).toBe(`${BOM}`);
      expect(result.generated).toBe("auto");
      expect(result.after).toBe("\ntail\n");
    });

    it("renderWithMarkers: round-trips a BOM-prefixed file without duplicating the block", () => {
      const original = `${BOM}intro\n${GENERATED_START}\nold\n${GENERATED_END}\nmanual\n`;
      const next = renderWithMarkers(original, "new", "handoff.md");
      expect(next).toBe(`${BOM}intro\n${GENERATED_START}\nnew\n${GENERATED_END}\nmanual\n`);
      // A second render is a clean no-op on the body (idempotent, no doubling).
      expect(renderWithMarkers(next, "new", "handoff.md")).toBe(next);
    });
  });

  // parseMarkers/renderWithMarkers/removeMarkerSection take a Markers pair
  // (default GENERATED). A non-default pair must select ITS markers and ignore
  // the other family's — the foundation of the `basou protocol` PROTOCOL block
  // coexisting with GENERATED blocks in the same file.
  describe("custom marker pair selection", () => {
    const PROTOCOL = { start: PROTOCOL_START, end: PROTOCOL_END };

    it("parseMarkers with the PROTOCOL pair matches PROTOCOL markers", () => {
      const body = `intro\n${PROTOCOL_START}\nrules\n${PROTOCOL_END}\ntail\n`;
      const result = parseMarkers(body, PROTOCOL);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.generated).toBe("rules");
    });

    it("the default (GENERATED) pair does not match a PROTOCOL block, and vice versa", () => {
      const protocolBody = `${PROTOCOL_START}\nrules\n${PROTOCOL_END}\n`;
      expect(parseMarkers(protocolBody)).toEqual({ kind: "no_markers" });
      const generatedBody = `${GENERATED_START}\nauto\n${GENERATED_END}\n`;
      expect(parseMarkers(generatedBody, PROTOCOL)).toEqual({ kind: "no_markers" });
    });
  });

  describe("removeMarkerSection", () => {
    it("removes an ok block and collapses the single newline after END, preserving before/after", () => {
      const body = `intro\n${GENERATED_START}\nauto\n${GENERATED_END}\ntail\n`;
      expect(removeMarkerSection(body, "handoff.md")).toBe("intro\ntail\n");
    });

    it("returns the input unchanged when there are no markers", () => {
      const body = "just prose\n";
      expect(removeMarkerSection(body, "handoff.md")).toBe(body);
    });

    it("throws on mismatched markers (missing END)", () => {
      const body = `${GENERATED_START}\nauto\n`;
      expect(() => removeMarkerSection(body, "decisions.md")).toThrow(
        "Markers mismatched in decisions.md",
      );
    });

    it("preserves a leading BOM and surrounding content when removing the block", () => {
      const BOM = "\uFEFF";
      const body = `${BOM}keep\n${GENERATED_START}\nauto\n${GENERATED_END}\nrest\n`;
      expect(removeMarkerSection(body, "handoff.md")).toBe(`${BOM}keep\nrest\n`);
    });

    it("removes a PROTOCOL block when given the PROTOCOL pair", () => {
      const body = `keep\n${PROTOCOL_START}\nrules\n${PROTOCOL_END}\nrest\n`;
      expect(
        removeMarkerSection(body, "CLAUDE.md", { start: PROTOCOL_START, end: PROTOCOL_END }),
      ).toBe("keep\nrest\n");
    });
  });

  it("round-trips parseMarkers + renderWithMarkers on the manual-notes case", async () => {
    // First write: no existing file
    const filePath = join(getWorkDir(), "handoff.md");
    const first = renderWithMarkers(null, "v1", "handoff.md");
    await writeMarkdownFile(filePath, first);
    // Append manual notes after the END marker
    const withManual = `${first}\n## My manual notes\nremember the meeting tomorrow\n`;
    await writeFile(filePath, withManual);
    // Second generation must preserve the manual additions
    const existing = await readMarkdownFile(filePath);
    const next = renderWithMarkers(existing, "v2", "handoff.md");
    expect(next).toContain("v2");
    expect(next).toContain("## My manual notes");
    expect(next).toContain("remember the meeting tomorrow");
  });
});
