/**
 * The anchor (planning master) repo's own AGENTS.md STARTER. Unlike a repo's
 * preset block or the workspace view's canonical — both marker-managed regions
 * that `basou project preset` keeps in sync — the anchor's own AGENTS.md is
 * HAND-MAINTAINED by design (preset deliberately skips the anchor, and its
 * canonical lives at the anchor root, never under `agents/`). A greenfield
 * bring-up (`basou project new` → declare → `basou project derive`) therefore
 * leaves the planning master with no conventions doc at all, while every project
 * onboarded the older way carries one from the start.
 *
 * This renders a MINIMAL starter so a greenfield anchor is not empty: identity,
 * commit-routing, per-repo AGENTS.md pointers, a pointer to the workspace view
 * for the LIVE roster, and TODO stubs for the policy basou cannot derive
 * (product facts, phase, secrets, language policy). It is meant to be written
 * ONCE if the file is absent and NEVER touched again (create-only, no
 * BASOU:GENERATED markers) — the operator owns and hand-maintains it thereafter,
 * preserving the anchor's hands-off design.
 *
 * It deliberately does NOT embed a roster snapshot table: a manifest-derived
 * table frozen into a markerless, never-resynced file would drift silently the
 * moment a repo is added / renamed / archived, with no staleness signal for a
 * reader (or an agent) that trusts it. The live roster lives in the workspace
 * view's own generated AGENTS.md, which stays in sync; the anchor points there.
 *
 * Pure and deterministic: it renders markdown from the declared fields only, so
 * the output is a function of the manifest snapshot at seed time. It embeds no
 * operator-specific string beyond the declared repo names / project name.
 */

/** One roster repo referenced by the anchor starter's per-repo pointers. */
export type AnchorStarterRepo = {
  /** The repo's display name (its on-disk basename). */
  name: string;
  /** True when this repo IS the anchor (the planning master itself; excluded from the pointers). */
  anchor?: boolean | undefined;
};

/** The declared fields the anchor starter is rendered from. */
export type AnchorStarterInput = {
  /** The anchor repo's display name (its on-disk basename) — names the file heading. */
  anchorName: string;
  /** `manifest.project.name`, when declared — used in the identity line. */
  projectName?: string | undefined;
  /** The workspace view's directory basename, when the project has a view. */
  viewName?: string | undefined;
  /** The declared roster (the anchor included), in declared order. */
  repos: AnchorStarterRepo[];
};

/**
 * Render the anchor's starter AGENTS.md (a full file, NOT a marker block). The
 * manifest-derived parts (identity, per-repo pointers) are filled from the
 * declaration; everything basou cannot know (product facts, phase, secrets,
 * language policy) is left as an explicit `<!-- TODO -->` for the operator. The
 * live roster is NOT snapshotted here — the file points at the workspace view's
 * generated AGENTS.md for it. Returns the file content WITH a trailing newline.
 */
export function renderAnchorStarter(input: AnchorStarterInput): string {
  const lines: string[] = [];
  const title = input.projectName ?? input.anchorName;

  lines.push(`# AGENTS.md (${input.anchorName})`);
  lines.push("");
  lines.push(
    `> このリポジトリは **${title} の planning master(anchor)** です。ここで作業する AI エージェントは、まずこのファイルを読んでください。`,
  );
  lines.push(">");
  lines.push(
    "> このファイルは `basou project derive` が greenfield 立ち上げ時に **一度だけ生成した starter** です。以後は手管理してください — basou は再生成も上書きもしません(BASOU:GENERATED マーカーは無く、自由に編集できます)。",
  );
  lines.push("");

  lines.push("## プロジェクトの基本情報");
  lines.push("");
  lines.push("<!-- TODO: manifest からは導出できない項目です。埋めてください。 -->");
  lines.push("");
  lines.push("```text");
  lines.push(`Product name:          ${input.projectName ?? "<!-- TODO -->"}`);
  lines.push("Domain:                <!-- TODO -->");
  lines.push("GitHub Organization:   <!-- TODO -->");
  lines.push("Public repository:     <!-- TODO -->");
  lines.push("Planning repository:   <!-- TODO -->");
  lines.push("License:               <!-- TODO -->");
  lines.push("```");
  lines.push("");

  lines.push("## どこで commit するか");
  lines.push("");
  lines.push("- **このリポジトリ(planning master)**: 構想・計画・設計ドキュメント。");
  lines.push("- **各実装 repo**: 実装コード。必ず対象 repo に `cd` してから commit してください。");
  lines.push("- **workspace view**: git 管理外。view では commit できません。");
  lines.push("");

  lines.push("## 必ず読むべき規約");
  lines.push("");
  lines.push("作業規約は各 repo の AGENTS.md にあります。以下を読んでから作業してください。");
  lines.push("");
  for (const r of input.repos) {
    if (r.anchor === true) continue; // this file
    lines.push(`- ${r.name}/AGENTS.md`);
  }
  if (input.viewName !== undefined) {
    lines.push(
      `- ${input.viewName}/AGENTS.md(workspace view・basou が生成)— **最新の repo 構成(roster)はここを正とする**`,
    );
  }
  lines.push("");

  lines.push("## 作業方針(プロジェクト固有事項)");
  lines.push("");
  lines.push("<!-- TODO: 以下をプロジェクトに合わせて記述してください。");
  lines.push("  - 現在のフェーズ / 重要ドキュメント");
  lines.push("  - 機密情報の扱い(どこに書かないか)");
  lines.push("  - 言語ポリシー(commit / コメント / ドキュメントの言語)");
  lines.push("  - commit 運用(混在コミットを避ける 等)");
  lines.push("-->");

  return `${lines.join("\n")}\n`;
}
