import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../schemas/manifest.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { createManifest, writeManifest } from "../storage/manifest.js";
import { resolveViewLanguage, resolveViewLanguageFromPaths, viewStrings } from "./view-strings.js";

type RepoEntry = NonNullable<Manifest["repos"]>[number];

function manifestWithRepos(repos: RepoEntry[]): Pick<Manifest, "repos"> {
  return { repos };
}

describe("resolveViewLanguage", () => {
  it("defaults to en when there is no manifest", () => {
    expect(resolveViewLanguage(null)).toBe("en");
  });

  it("defaults to en when the manifest declares no roster", () => {
    expect(resolveViewLanguage({})).toBe("en");
  });

  it("defaults to en when the anchor declares no language", () => {
    expect(resolveViewLanguage(manifestWithRepos([{ path: "." }]))).toBe("en");
  });

  it("resolves ja from the anchor repo's declared language", () => {
    expect(resolveViewLanguage(manifestWithRepos([{ path: ".", language: "ja" }]))).toBe("ja");
  });

  it("normalizes the anchor path before matching (./ is the anchor)", () => {
    expect(resolveViewLanguage(manifestWithRepos([{ path: "./", language: "ja" }]))).toBe("ja");
  });

  it("resolves en from an en anchor", () => {
    expect(resolveViewLanguage(manifestWithRepos([{ path: ".", language: "en" }]))).toBe("en");
  });

  it("resolves en+ja to en (one chrome language; en is the shared floor)", () => {
    expect(resolveViewLanguage(manifestWithRepos([{ path: ".", language: "en+ja" }]))).toBe("en");
  });

  it("ignores non-anchor repos' languages (the workspace speaks the anchor's language)", () => {
    expect(
      resolveViewLanguage(
        manifestWithRepos([
          { path: ".", language: "en" },
          { path: "../sibling", language: "ja" },
        ]),
      ),
    ).toBe("en");
    expect(resolveViewLanguage(manifestWithRepos([{ path: "../sibling", language: "ja" }]))).toBe(
      "en",
    );
  });
});

describe("resolveViewLanguageFromPaths", () => {
  let workDir: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "basou-view-strings-test-"));
  });

  afterEach(async () => {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  async function setupPaths(): Promise<BasouPaths> {
    if (workDir === undefined) throw new Error("workDir not initialized");
    return ensureBasouDirectory(workDir);
  }

  it("defaults to en when the manifest is missing (never breaks a render)", async () => {
    const paths = await setupPaths();
    expect(await resolveViewLanguageFromPaths(paths)).toBe("en");
  });

  it("resolves ja from a manifest whose anchor declares ja", async () => {
    const paths = await setupPaths();
    const manifest = createManifest({ workspaceName: "fixture" });
    manifest.repos = [{ path: ".", language: "ja" }];
    await writeManifest(paths, manifest);
    expect(await resolveViewLanguageFromPaths(paths)).toBe("ja");
  });
});

describe("viewStrings", () => {
  it("returns distinct chrome per language while sharing the key shape", () => {
    const en = viewStrings("en");
    const ja = viewStrings("ja");
    expect(en.orientation.headingWhere).toBe("## Where you are now");
    expect(ja.orientation.headingWhere).toBe("## 今どこにいる");
    expect(en.handoff.headingSessions).toBe("## Sessions");
    expect(ja.handoff.headingSessions).toBe("## セッション一覧");
  });

  it("localizes relative ages", () => {
    const now = new Date("2026-05-09T03:00:00.000Z");
    const en = viewStrings("en");
    const ja = viewStrings("ja");
    expect(en.relativeAge("2026-05-08T00:30:00.000Z", now)).toBe("1d 2h ago");
    expect(ja.relativeAge("2026-05-08T00:30:00.000Z", now)).toBe("1日2時間前");
    expect(en.relativeAge(null, now)).toBe("(unknown)");
    expect(ja.relativeAge(null, now)).toBe("(不明)");
    expect(en.relativeAge("2026-05-09T02:59:30.000Z", now)).toBe("just now");
    expect(ja.relativeAge("2026-05-09T02:59:30.000Z", now)).toBe("たった今");
  });

  // Sweep every parameterized table entry in BOTH languages: a table entry that
  // throws or renders empty would corrupt a view at runtime, and the renderers
  // only exercise the branches a given fixture hits. This also keeps the two
  // tables honest — each function must produce a non-empty line for plausible
  // inputs, whichever language is selected.
  it("every parameterized entry renders a non-empty line in both languages", () => {
    const now = new Date("2026-05-09T03:00:00.000Z");
    for (const lang of ["en", "ja"] as const) {
      const t = viewStrings(lang);
      const rendered: string[] = [
        // relativeAge branch matrix: unknown / future / just-now / m / h / h+m / d / d+h
        t.relativeAge(null, now),
        t.relativeAge("2026-05-09T04:00:00.000Z", now),
        t.relativeAge("2026-05-09T02:59:30.000Z", now),
        t.relativeAge("2026-05-09T02:30:00.000Z", now),
        t.relativeAge("2026-05-09T01:00:00.000Z", now),
        t.relativeAge("2026-05-09T01:30:30.000Z", now),
        t.relativeAge("2026-05-07T03:00:00.000Z", now),
        t.relativeAge("2026-05-07T01:00:00.000Z", now),
        t.common.decisionOtherSessionNote("ses_0123456789"),
        t.orientation.headingRecent(5),
        t.orientation.inFlightTasksHeading(1),
        t.orientation.pendingApprovalsHeading(1),
        t.orientation.suspectSessionsHeading(1),
        t.orientation.openTracksHeading(1),
        t.orientation.decisionStaleNote("1h ago"),
        t.orientation.outOfRootWarning(1, "a.ts"),
        t.orientation.nextStepRecordedLabel("1h ago"),
        t.orientation.noteStaleNote("1h ago"),
        t.orientation.bannerUnverifiable(1),
        t.orientation.bannerStale("2 new"),
        t.orientation.partNew(2),
        t.orientation.partUpdated(1),
        ...t.orientation.verdictUnverifiable(1),
        ...t.orientation.verdictStale("2 new"),
        ...t.orientation.verdictUpdatedOnly(1),
        t.orientation.verdictSuspectsAlso(1),
        ...t.orientation.verdictEmpty,
        ...t.orientation.verdictUnprobed("1h ago", "terminal"),
        t.orientation.verdictCurrent("1h ago", "terminal", false),
        t.orientation.verdictCurrent("1h ago", "terminal", true),
        t.orientation.verdictSuspectsCaveat(1),
      ];
      for (const line of rendered) {
        expect(typeof line).toBe("string");
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });
});
