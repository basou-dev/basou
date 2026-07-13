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

import { presetStrings, resolveAnchorContentLanguage } from "../lib/view-strings.js";
import type { RepoLanguage } from "./roster.js";

/** One roster repo referenced by the anchor starter's per-repo pointers. */
export type AnchorStarterRepo = {
  /** The repo's display name (its on-disk basename). */
  name: string;
  /** True when this repo IS the anchor (the planning master itself; excluded from the pointers). */
  anchor?: boolean | undefined;
  /**
   * The repo's declared `language`. Only the ANCHOR entry's value participates:
   * the starter is the anchor's own file, so its content language follows the
   * anchor's declared audience (`ja` renders the pre-i18n Japanese bytes;
   * anything else renders English).
   */
  language?: RepoLanguage | undefined;
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
 * generated AGENTS.md for it. The content language follows the ANCHOR entry's
 * declared `language` (a ja anchor renders byte-identical to the pre-i18n
 * output; anything else renders English). Returns the file content WITH a
 * trailing newline.
 */
export function renderAnchorStarter(input: AnchorStarterInput): string {
  const t = presetStrings(resolveAnchorContentLanguage(input.repos)).anchorStarter;
  const lines: string[] = [];
  const title = input.projectName ?? input.anchorName;

  lines.push(`# AGENTS.md (${input.anchorName})`);
  lines.push("");
  lines.push(t.identityLine(title));
  lines.push(">");
  lines.push(t.starterNote);
  lines.push("");

  lines.push(t.basicsHeading);
  lines.push("");
  lines.push(t.basicsTodo);
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

  lines.push(t.commitHeading);
  lines.push("");
  lines.push(t.commitPlanning);
  lines.push(t.commitImplementation);
  lines.push(t.commitView);
  lines.push("");

  lines.push(t.conventionsHeading);
  lines.push("");
  lines.push(t.conventionsBody);
  lines.push("");
  for (const r of input.repos) {
    if (r.anchor === true) continue; // this file
    lines.push(`- ${r.name}/AGENTS.md`);
  }
  if (input.viewName !== undefined) {
    lines.push(t.viewPointerLine(input.viewName));
  }
  lines.push("");

  lines.push(t.policyHeading);
  lines.push("");
  lines.push(...t.policyTodo);

  return `${lines.join("\n")}\n`;
}
