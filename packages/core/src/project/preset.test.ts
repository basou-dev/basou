import { describe, expect, it } from "vitest";
import {
  isRenderable,
  type RepoPresetFacts,
  renderPresetBlock,
  renderViewPresetBlock,
  summarizePresetPlan,
} from "./preset.js";

describe("renderPresetBlock", () => {
  it("renders visibility, source language, and ordered published surfaces", () => {
    const block = renderPresetBlock({
      visibility: "private",
      language: "en",
      publishes: [
        { kind: "web", visibility: "public", language: "en+ja" },
        { kind: "npm", visibility: "public", language: "en" },
      ],
    });
    expect(block).toContain("ソース可視性: private(git 履歴は非公開)");
    expect(block).toContain("ソース言語: en(commit・コメント・コードは英語)");
    expect(block).toContain("- 配信物:");
    expect(block).toContain("web(デプロイ) — 公開 / en+ja");
    expect(block).toContain("npm(パッケージ) — 公開 / en");
    // web is declared first, so it renders first.
    expect(block.indexOf("web(デプロイ)")).toBeLessThan(block.indexOf("npm(パッケージ)"));
  });

  it("renders '配信物: なし' when there are no published surfaces", () => {
    const block = renderPresetBlock({ visibility: "public", language: "en" });
    expect(block).toContain("- 配信物: なし");
  });

  it("renders 未設定 for unset visibility/language and partial publish fields", () => {
    const block = renderPresetBlock({ publishes: [{ kind: "web" }] });
    expect(block).toContain("ソース可視性: 未設定");
    expect(block).toContain("ソース言語: 未設定");
    expect(block).toContain("web(デプロイ) — 可視性未設定 / 言語未設定");
  });

  it("is deterministic (byte-identical for the same input) and has no trailing newline", () => {
    const repo = { visibility: "public" as const, language: "ja" as const };
    expect(renderPresetBlock(repo)).toBe(renderPresetBlock(repo));
    expect(renderPresetBlock(repo).endsWith("\n")).toBe(false);
  });
});

describe("isRenderable", () => {
  it("is false only when visibility, language, and publishes are all absent", () => {
    expect(isRenderable({})).toBe(false);
    expect(isRenderable({ publishes: [] })).toBe(false);
    expect(isRenderable({ visibility: "public" })).toBe(true);
    expect(isRenderable({ language: "en" })).toBe(true);
    expect(isRenderable({ publishes: [{ kind: "npm" }] })).toBe(true);
  });
});

/** Build a facts record with sensible defaults for the common reachable case. */
function facts(over: Partial<RepoPresetFacts> & { path: string }): RepoPresetFacts {
  return {
    isAnchor: false,
    reachable: true,
    canonicalPresent: false,
    canonicalName: over.canonicalName ?? "x",
    ...over,
  };
}

describe("summarizePresetPlan", () => {
  it("plans a create for a renderable repo whose canonical is absent", () => {
    const s = summarizePresetPlan([
      facts({ path: "../x", visibility: "public", canonicalPresent: false }),
    ]);
    expect(s.plans).toHaveLength(1);
    expect(s.plans[0]?.action).toBe("create");
    expect(s.plans[0]?.path).toBe("../x");
    expect(s.plans[0]?.desiredBlock).toContain("ソース可視性: public");
    expect(s.ok).toBe(false);
  });

  it("plans an update when the canonical's ok region differs from desired", () => {
    const s = summarizePresetPlan([
      facts({
        path: "../x",
        visibility: "public",
        canonicalPresent: true,
        markerKind: "ok",
        currentBlock: "stale content",
      }),
    ]);
    expect(s.plans[0]?.action).toBe("update");
  });

  it("reports inSync when the ok region already matches desired (newline-tolerant)", () => {
    const desired = renderPresetBlock({ visibility: "public" });
    const s = summarizePresetPlan([
      facts({
        path: "../x",
        visibility: "public",
        canonicalPresent: true,
        markerKind: "ok",
        // a trailing newline difference must not count as drift
        currentBlock: `${desired}\n`,
      }),
    ]);
    expect(s.inSync).toEqual(["../x"]);
    expect(s.plans).toEqual([]);
    expect(s.ok).toBe(true);
  });

  it("surfaces a present-but-markerless canonical as a marker conflict (never overwrites)", () => {
    const s = summarizePresetPlan([
      facts({
        path: "../x",
        visibility: "public",
        canonicalPresent: true,
        markerKind: "no_markers",
      }),
    ]);
    expect(s.plans).toEqual([]);
    expect(s.markerConflicts).toEqual([{ repo: "../x", reason: "no_markers" }]);
    expect(s.ok).toBe(false);
  });

  it("treats malformed markers as a conflict, not an overwrite", () => {
    for (const reason of ["missing_start", "multiple_pairs", "wrong_order"] as const) {
      const s = summarizePresetPlan([
        facts({ path: "../x", visibility: "public", canonicalPresent: true, markerKind: reason }),
      ]);
      expect(s.markerConflicts).toEqual([{ repo: "../x", reason }]);
    }
  });

  it("degrades a present-but-unreadable canonical to unreadable (never generated)", () => {
    const s = summarizePresetPlan([
      facts({
        path: "../x",
        visibility: "public",
        canonicalPresent: true,
        canonicalReadable: false,
      }),
    ]);
    expect(s.unreadable).toEqual(["../x"]);
    expect(s.plans).toEqual([]);
    expect(s.ok).toBe(false);
  });

  it("reports a repo with nothing declared as undeclared (not generated)", () => {
    const s = summarizePresetPlan([facts({ path: "../x" })]);
    expect(s.undeclared).toEqual(["../x"]);
    expect(s.plans).toEqual([]);
    expect(s.ok).toBe(false);
  });

  it("skips the anchor (its own AGENTS.md is hand-maintained) without blocking ok", () => {
    const s = summarizePresetPlan([
      facts({ path: ".", isAnchor: true, visibility: "private" }),
      facts({
        path: "../x",
        visibility: "public",
        canonicalName: "x",
        canonicalPresent: true,
        markerKind: "ok",
        currentBlock: renderPresetBlock({ visibility: "public" }),
      }),
    ]);
    expect(s.anchors).toEqual(["."]);
    expect(s.inSync).toEqual(["../x"]);
    expect(s.ok).toBe(true);
  });

  it("reports an unreachable repo and never plans it", () => {
    const s = summarizePresetPlan([
      facts({ path: "../gone", reachable: false, visibility: "public" }),
    ]);
    expect(s.unreachable).toEqual(["../gone"]);
    expect(s.plans).toEqual([]);
    expect(s.ok).toBe(false);
  });

  it("surfaces two distinct repos sharing one canonical as a collision and generates neither", () => {
    const s = summarizePresetPlan([
      facts({ path: "../a/x", canonicalName: "x", visibility: "public" }),
      facts({ path: "../b/x", canonicalName: "x", visibility: "public" }),
    ]);
    expect(s.collisions).toEqual([{ canonicalName: "x", repos: ["../a/x", "../b/x"] }]);
    expect(s.plans).toEqual([]);
    expect(s.ok).toBe(false);
  });

  it("dedups a repo listed twice by normalized path (first wins, no duplicate plan)", () => {
    const s = summarizePresetPlan([
      facts({ path: "../x", canonicalName: "x", visibility: "public" }),
      facts({ path: "../x/", canonicalName: "x", visibility: "public" }),
    ]);
    expect(s.plans).toHaveLength(1);
  });

  it("ok is true only when everything is in sync and nothing was skipped", () => {
    const inSyncFact = (path: string): RepoPresetFacts =>
      facts({
        path,
        canonicalName: path.replace("../", ""),
        visibility: "public",
        canonicalPresent: true,
        markerKind: "ok",
        currentBlock: renderPresetBlock({ visibility: "public" }),
      });
    expect(summarizePresetPlan([inSyncFact("../a"), inSyncFact("../b")]).ok).toBe(true);
  });

  it("reports a self repo as self and never plans a write into its hand-authored AGENTS.md", () => {
    const s = summarizePresetPlan([
      // Even with renderable fields and a present canonical, a self repo is hands-off.
      facts({
        path: "../blog",
        self: true,
        visibility: "public",
        language: "ja",
        canonicalPresent: true,
        markerKind: "ok",
        currentBlock: "anything",
      }),
    ]);
    expect(s.self).toEqual(["../blog"]);
    expect(s.plans).toEqual([]);
    expect(s.inSync).toEqual([]);
    // A self repo does not block the clean verdict (intentionally not generated).
    expect(s.ok).toBe(true);
  });

  it("excludes self repos from canonical-name collision detection", () => {
    const s = summarizePresetPlan([
      facts({ path: "../x/blog", self: true, canonicalName: "blog", visibility: "public" }),
      facts({ path: "../y/blog", self: true, canonicalName: "blog", visibility: "public" }),
    ]);
    expect(s.collisions).toEqual([]);
    expect(s.self).toEqual(["../x/blog", "../y/blog"]);
    expect(s.ok).toBe(true);
  });

  it("suppresses a repo whose canonical name equals the view's (a view-flagged collision)", () => {
    const s = summarizePresetPlan(
      [
        facts({ path: "../ws", canonicalName: "ws", visibility: "public" }),
        facts({ path: "../other", canonicalName: "other", visibility: "public" }),
      ],
      { viewCanonicalName: "ws" },
    );
    // The colliding repo is suppressed (no plan), surfaced as a view collision.
    expect(s.collisions).toEqual([{ canonicalName: "ws", repos: ["../ws"], view: true }]);
    expect(s.plans.map((p) => p.path)).toEqual(["../other"]);
    expect(s.ok).toBe(false);
  });

  it("without the view option, the same facts are unchanged (no view collision)", () => {
    const s = summarizePresetPlan([
      facts({ path: "../ws", canonicalName: "ws", visibility: "public" }),
    ]);
    expect(s.collisions).toEqual([]);
    expect(s.plans.map((p) => p.path)).toEqual(["../ws"]);
  });
});

describe("renderViewPresetBlock", () => {
  it("renders the header, repo count, aggregation table, commit / read / principle sections", () => {
    const block = renderViewPresetBlock({
      viewName: "ws",
      repos: [
        { name: "acme", visibility: "public", language: "en" },
        { name: "acme-planning", visibility: "private", language: "ja" },
      ],
    });
    expect(block).toContain("## workspace view 構成(basou が生成 — manifest が正本)");
    expect(block).toContain("宣言された 2 個の repo を symlink で集約する");
    // The aggregation table: header plus one row per repo, in declared order.
    expect(block).toContain("| repo | 可視性 | 言語 | 指示書 |");
    expect(block).toContain("| acme | public | en | hub(basou が生成) |");
    expect(block).toContain("| acme-planning | private | ja | hub(basou が生成) |");
    // Commit / read / principle sections.
    expect(block).toContain("- acme → `cd acme`");
    expect(block).toContain("- acme-planning/AGENTS.md");
    expect(block).toContain("### 重要原則");
    expect(block).toContain("- このディレクトリは状態を持たない(git 管理外)");
  });

  it("describes itself as generated, naming its own canonical (agents/<viewName>/AGENTS.md)", () => {
    const block = renderViewPresetBlock({ viewName: "my-workspace", repos: [{ name: "a" }] });
    expect(block).toContain("この AGENTS.md 自身も basou の生成物です");
    expect(block).toContain("`agents/my-workspace/AGENTS.md`");
  });

  it("marks an instructions: self repo as self-managed in the instruction column", () => {
    const block = renderViewPresetBlock({
      viewName: "ws",
      repos: [
        { name: "hubbed", visibility: "public", language: "en" },
        { name: "selfish", visibility: "public", language: "ja", self: true },
      ],
    });
    expect(block).toContain("| hubbed | public | en | hub(basou が生成) |");
    expect(block).toContain("| selfish | public | ja | self(repo が自己管理) |");
  });

  it("marks the anchor as hand-maintained (never hub) in the instruction column", () => {
    const block = renderViewPresetBlock({
      viewName: "ws",
      repos: [
        // The anchor's AGENTS.md is hand-maintained (preset skips it), so it is
        // labeled `anchor`, not `hub` — even though it is not `instructions: self`.
        { name: "planning", visibility: "private", language: "ja", anchor: true },
        { name: "impl", visibility: "public", language: "en" },
      ],
    });
    expect(block).toContain("| planning | private | ja | anchor(手管理) |");
    expect(block).toContain("| impl | public | en | hub(basou が生成) |");
    // `anchor` wins over an incidental `self` flag on the same row.
    const both = renderViewPresetBlock({
      viewName: "ws",
      repos: [{ name: "planning", anchor: true, self: true }],
    });
    expect(both).toContain("| planning | 未設定 | 未設定 | anchor(手管理) |");
  });

  it("preserves the declared repo order in every list", () => {
    const block = renderViewPresetBlock({
      viewName: "ws",
      repos: [{ name: "z" }, { name: "a" }, { name: "m" }],
    });
    // Table rows, cd lines, and AGENTS.md lines all follow the input order (not sorted).
    expect(block.indexOf("| z |")).toBeLessThan(block.indexOf("| a |"));
    expect(block.indexOf("| a |")).toBeLessThan(block.indexOf("| m |"));
    expect(block.indexOf("`cd z`")).toBeLessThan(block.indexOf("`cd a`"));
    expect(block.indexOf("- z/AGENTS.md")).toBeLessThan(block.indexOf("- a/AGENTS.md"));
  });

  it("renders each visibility / language value verbatim (short labels)", () => {
    const block = renderViewPresetBlock({
      viewName: "ws",
      repos: [
        { name: "pub", visibility: "public", language: "en" },
        { name: "priv", visibility: "private", language: "ja" },
        { name: "future", visibility: "future-public", language: "en+ja" },
      ],
    });
    expect(block).toContain("| pub | public | en |");
    expect(block).toContain("| priv | private | ja |");
    expect(block).toContain("| future | future-public | en+ja |");
  });

  it("renders 未設定 for unset visibility / language", () => {
    const block = renderViewPresetBlock({ viewName: "ws", repos: [{ name: "bare" }] });
    expect(block).toContain("| bare | 未設定 | 未設定 |");
  });

  it("renders cleanly for an empty roster (0 repos, header-only table, empty lists)", () => {
    const block = renderViewPresetBlock({ viewName: "ws", repos: [] });
    expect(block).toContain("宣言された 0 個の repo を symlink で集約する");
    expect(block).toContain("| repo | 可視性 | 言語 | 指示書 |");
    expect(block).toContain("|---|---|---|---|");
    // No repo rows / cd lines / AGENTS.md lines (the self-description names
    // `agents/ws/AGENTS.md`, so the check is scoped to list items).
    expect(block).not.toContain("`cd ");
    expect(block).not.toContain("- ws/AGENTS.md");
    expect(block).not.toMatch(/^- .*\/AGENTS\.md$/m);
  });

  it("is deterministic (byte-identical for the same input) and has no trailing newline", () => {
    const input = {
      viewName: "ws",
      repos: [{ name: "basou", visibility: "public" as const, language: "en" as const }],
    };
    const a = renderViewPresetBlock(input);
    const b = renderViewPresetBlock(input);
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(false);
  });
});
