import { describe, expect, it } from "vitest";
import { renderAnchorStarter } from "./anchor-starter.js";

describe("renderAnchorStarter", () => {
  it("renders the heading, identity line, commit-routing, and per-repo pointers", () => {
    const doc = renderAnchorStarter({
      anchorName: "acme-planning",
      viewName: "acme-workspace",
      repos: [{ name: "acme-planning", anchor: true }, { name: "acme" }, { name: "acme-beta" }],
    });
    expect(doc).toContain("# AGENTS.md (acme-planning)");
    // Identity falls back to the anchor name when no project name is declared.
    expect(doc).toContain("**acme-planning の planning master(anchor)**");
    // Commit-routing is prose, not a per-repo table.
    expect(doc).toContain("## どこで commit するか");
    expect(doc).toContain("**このリポジトリ(planning master)**");
    // Per-repo pointers exclude the anchor (that IS this file).
    expect(doc).toContain("- acme/AGENTS.md");
    expect(doc).toContain("- acme-beta/AGENTS.md");
    expect(doc).not.toContain("- acme-planning/AGENTS.md");
  });

  it("does NOT snapshot a roster table into the frozen file (points at the view for the live roster)", () => {
    const doc = renderAnchorStarter({
      anchorName: "acme-planning",
      viewName: "acme-workspace",
      repos: [{ name: "acme-planning", anchor: true }, { name: "acme" }],
    });
    // No manifest-derived roster snapshot table (it would drift silently in a
    // markerless, never-resynced file).
    expect(doc).not.toContain("| repo | 可視性 | 言語 | 指示書 |");
    expect(doc).not.toContain("スナップショット");
    // Instead, the view's generated AGENTS.md is the live-roster source of truth.
    expect(doc).toContain(
      "- acme-workspace/AGENTS.md(workspace view・basou が生成)— **最新の repo 構成(roster)はここを正とする**",
    );
  });

  it("declares itself a create-only, marker-less starter that basou never rewrites", () => {
    const doc = renderAnchorStarter({ anchorName: "p", repos: [{ name: "p", anchor: true }] });
    expect(doc).toContain("一度だけ生成した starter");
    expect(doc).toContain("basou は再生成も上書きもしません");
    // It must NOT carry BASOU:GENERATED markers — it is hand-maintained, not synced.
    expect(doc).not.toContain("BASOU:GENERATED:START");
    expect(doc).not.toContain("BASOU:GENERATED:END");
  });

  it("uses the declared project name in the identity line and info block when present", () => {
    const doc = renderAnchorStarter({
      anchorName: "acme-planning",
      projectName: "Acme",
      repos: [{ name: "acme-planning", anchor: true }],
    });
    expect(doc).toContain("**Acme の planning master(anchor)**");
    expect(doc).toContain("Product name:          Acme");
  });

  it("leaves undeclarable product facts as TODO stubs", () => {
    const doc = renderAnchorStarter({ anchorName: "p", repos: [{ name: "p", anchor: true }] });
    // No project name declared => the product-name field is a TODO too.
    expect(doc).toContain("Product name:          <!-- TODO -->");
    expect(doc).toContain("Domain:                <!-- TODO -->");
    expect(doc).toContain("GitHub Organization:   <!-- TODO -->");
    expect(doc).toContain("License:               <!-- TODO -->");
    // Project-specific policy is left for the operator to fill.
    expect(doc).toContain("## 作業方針(プロジェクト固有事項)");
    expect(doc).toContain("言語ポリシー");
  });

  it("omits the view pointer when the project has no workspace view", () => {
    const doc = renderAnchorStarter({
      anchorName: "solo-planning",
      repos: [{ name: "solo-planning", anchor: true }, { name: "solo" }],
    });
    expect(doc).toContain("- solo/AGENTS.md");
    expect(doc).not.toContain("workspace view・basou が生成");
  });

  it("is deterministic (byte-identical) for the same input and ends with a newline", () => {
    const input = {
      anchorName: "acme-planning",
      viewName: "acme-workspace",
      repos: [{ name: "acme-planning", anchor: true }, { name: "acme" }],
    };
    expect(renderAnchorStarter(input)).toBe(renderAnchorStarter(input));
    expect(renderAnchorStarter(input).endsWith("\n")).toBe(true);
  });
});
