import { normalizeRelativePath } from "../project/relative-path.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { readManifest } from "../storage/manifest.js";

/**
 * The language of the GENERATED-VIEW chrome (headings, labels, verdict prose)
 * in handoff.md / orientation.md / decisions.md / report output.
 *
 * This is deliberately narrower than the manifest's repo `language` axis
 * (`en | ja | en+ja`): a generated view has exactly one chrome language, so
 * `en+ja` resolves to `en`. User data (decision titles, notes, labels, file
 * paths) always passes through verbatim — only the tool-generated strings are
 * localized, which is exactly the split this type exists to keep honest.
 */
export type ViewLanguage = "en" | "ja";

/**
 * Resolve the generated-view language from a manifest: the workspace speaks
 * the language of its ANCHOR repo (the `repos[]` entry whose path is `.`).
 *
 * Rules (fixed by design):
 * - anchor declares `ja`            -> `ja`
 * - anchor declares `en` / `en+ja`  -> `en` (a bilingual surface renders one
 *   chrome; en is the shared floor)
 * - no roster / no anchor entry / no declared language -> `en` (the default
 *   for basou's English-first OSS surface)
 *
 * Binding the view to the anchor's language is a deliberate, documented
 * coupling: the anchor is the planning/trail home the views live in, so its
 * declared audience is the views' audience. Other repos' languages do not
 * participate.
 */
export function resolveViewLanguage(manifest: Pick<Manifest, "repos"> | null): ViewLanguage {
  if (manifest === null) return "en";
  const anchor = manifest.repos?.find((r) => normalizeRelativePath(r.path) === ".");
  return anchor?.language === "ja" ? "ja" : "en";
}

/**
 * Manifest-reading convenience for the renderers: resolve the view language
 * for a workspace, defaulting to `en` when the manifest is missing or
 * unreadable (mirrors the orientation renderer's tolerant source_roots read —
 * a broken manifest must never break a view render).
 */
export async function resolveViewLanguageFromPaths(paths: BasouPaths): Promise<ViewLanguage> {
  try {
    return resolveViewLanguage(await readManifest(paths));
  } catch {
    return "en";
  }
}

/**
 * Every localized string the four view renderers emit, grouped per renderer
 * with a small `common` set for lines that are byte-identical across views.
 * Parameterized lines are functions so the two languages can order their
 * parts naturally.
 *
 * This module is the SINGLE home for generated-view Japanese (the E-5
 * language-lint allowlist points here, not at the renderers), so "user data
 * language" and "tool chrome language" can never blur together again.
 */
export type ViewStrings = {
  /** Localized relative age for prose lines, e.g. "3日4時間前" / "3d 4h ago". */
  relativeAge: (startedAt: string | null, now: Date) => string;
  common: {
    /** "最終 session" — the latest live session pointer. */
    lastSessionLabel: string;
    /** "直近の判断" — the latest recorded decision pointer. */
    latestDecisionLabel: string;
    /** "直近の変更ファイル" — the latest session's related files. */
    recentFilesLabel: string;
    /** "理由" — a track's rationale label. */
    trackWhyLabel: string;
    /** Note that the latest decision comes from a different session. */
    decisionOtherSessionNote: (shortSessionId: string) => string;
  };
  orientation: {
    headingWhere: string;
    headingRecent: (sessionCount: number) => string;
    headingInFlight: string;
    headingForward: string;
    headingCurrency: string;
    inFlightTasksHeading: (n: number) => string;
    pendingApprovalsHeading: (n: number) => string;
    suspectSessionsHeading: (n: number) => string;
    openTracksHeading: (n: number) => string;
    /** Stale-decision honesty note under 直近の判断. */
    decisionStaleNote: (activityAge: string) => string;
    outOfRootWarning: (count: number, files: string) => string;
    recentEmpty: string;
    recentDecisionsLabel: string;
    recentNextStepLabel: string;
    recentChangedLabel: string;
    trackCloseInstruction: string;
    nextStepRecordedLabel: (age: string) => string;
    noteStaleNote: (activityAge: string) => string;
    fallbackStaleDirection: string;
    fallbackStaleReferenceLabel: string;
    trackNudge: string;
    federatedFreshnessNote: string;
    bannerUnverifiable: (n: number) => string;
    bannerStale: (parts: string) => string;
    partNew: (n: number) => string;
    partUpdated: (n: number) => string;
    partsJoiner: string;
    verdictUnverifiable: (n: number) => [string, string];
    verdictStale: (parts: string) => [string, string];
    verdictUpdatedOnly: (n: number) => [string, string];
    verdictSuspectsAlso: (n: number) => string;
    verdictEmpty: [string, string];
    verdictUnprobed: (rel: string, tool: string) => [string, string];
    verdictCurrent: (rel: string, tool: string, hasHosts: boolean) => string;
    verdictSuspectsCaveat: (n: number) => string;
    verdictScopeDisclaimer: string;
    toolTerminal: string;
    toolHuman: string;
    toolImport: string;
    toolUnknown: string;
  };
  handoff: {
    headingCurrentState: string;
    headingRecentFiles: string;
    headingLatestDecision: string;
    headingOpenTracks: string;
    headingUnresolved: string;
    headingReadNext: string;
    headingNextWork: string;
    headingSessions: string;
    lastTaskLabel: string;
    decisionStaleNote: string;
    trackCloseInstruction: string;
  };
  decisions: {
    dateLabel: string;
    trackKindLine: string;
    decisionLabel: string;
  };
  report: {
    headingSummary: string;
    headingVolume: string;
    headingDecisions: string;
    headingApprovals: string;
    headingTasks: string;
    headingChangedFiles: string;
    headingSessions: string;
    headingIntegrity: string;
  };
};

/** Look up the string table for a resolved view language. */
export function viewStrings(language: ViewLanguage): ViewStrings {
  return language === "ja" ? JA : EN;
}

/** "3d 4h ago" / "just now" / "(unknown)" — the en localized relative age. */
function relativeAgeEn(startedAt: string | null, now: Date): string {
  if (startedAt === null) return "(unknown)";
  const ms = now.getTime() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  if (ms < 60_000) return "just now";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h ago` : `${days}d ago`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
  return `${mins}m ago`;
}

/** "3日4時間前" / "たった今" / "(不明)" — the ja localized relative age. */
function relativeAgeJa(startedAt: string | null, now: Date): string {
  if (startedAt === null) return "(不明)";
  const ms = now.getTime() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "たった今";
  if (ms < 60_000) return "たった今";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}日${hours}時間前` : `${days}日前`;
  if (hours > 0) return mins > 0 ? `${hours}時間${mins}分前` : `${hours}時間前`;
  return `${mins}分前`;
}

const EN: ViewStrings = {
  relativeAge: relativeAgeEn,
  common: {
    lastSessionLabel: "Last session",
    latestDecisionLabel: "Latest decision",
    recentFilesLabel: "Recently changed files",
    trackWhyLabel: "Why",
    decisionOtherSessionNote: (sid) =>
      `Note: this decision comes from a different session [${sid}] than the last session.`,
  },
  orientation: {
    headingWhere: "## Where you are now",
    headingRecent: (n) => `## Recent direction (last ${n} sessions)`,
    headingInFlight: "## What is in flight",
    headingForward: "## Where you are heading",
    headingCurrency: "## Is this current",
    inFlightTasksHeading: (n) => `### In-flight tasks (${n})`,
    pendingApprovalsHeading: (n) => `### Pending approvals (${n})`,
    suspectSessionsHeading: (n) => `### Suspect sessions (${n})`,
    openTracksHeading: (n) => `### Open tracks (shown until closed) (${n})`,
    decisionStaleNote: (age) =>
      `Note: this is the latest *recorded* decision. The latest activity (${age}) is more recent, so the current direction may not be reflected here (conversational decisions are not captured automatically; record this session's decisions with \`basou decision capture\`).`,
    outOfRootWarning: (count, files) =>
      `⚠ ${count} outside source_roots (possibly another project): ${files}`,
    recentEmpty: "(no records yet)",
    recentDecisionsLabel: "Decisions",
    recentNextStepLabel: "Next step",
    recentChangedLabel: "Changed",
    trackCloseInstruction:
      "When finished, close it with `basou decision void <decision_id>`. It stays listed here every time until closed.",
    nextStepRecordedLabel: (age) => `Next step (recorded, ${age})`,
    noteStaleNote: (age) =>
      `Note: work continued after this was recorded (latest activity ${age}), so this starting point may be stale.`,
    fallbackStaleDirection:
      "- (no planned tasks or recorded next step — the latest activity postdates the latest decision; ask the user for the continuation point)",
    fallbackStaleReferenceLabel: "Reference (possibly stale — not the current direction)",
    trackNudge:
      'Once the next essential direction is settled, record it as a track with `basou decision capture` (`"kind":"track"`) / `basou decision record --track` — it stays surfaced here every session until closed.',
    federatedFreshnessNote:
      "Note: the freshness verdict covers only this machine's local store. Missed work on other hosts cannot be assessed here (run `basou refresh` on each host to sync).",
    bannerUnverifiable: (n) =>
      `> ⚠️ **Re-import needed** — ${n} session(s) changed in the native logs but cannot be imported by a plain refresh. Re-import with \`basou refresh --force\` (details under "Is this current" at the bottom).`,
    bannerStale: (parts) =>
      `> ⚠️ **Stale (uncaptured: ${parts})** — run \`basou refresh\` before starting work (details under "Is this current" at the bottom).`,
    partNew: (n) => `${n} new`,
    partUpdated: (n) => `${n} updated`,
    partsJoiner: ", ",
    verdictUnverifiable: (n) => [
      `⚠️ The native logs changed, but ${n} session(s) cannot be safely re-imported by a plain \`basou refresh\` (non-append changes, prior-chain mismatch, etc.).`,
      "Re-import with `basou refresh --force`. (`basou verify` is a different check — it inspects already-imported data for tampering/corruption, a separate axis from the suspect count in the header. A clean verify can still leave uncaptured work.)",
    ],
    verdictStale: (parts) => [
      `⚠️ Stale. There is uncaptured work since the last import (${parts}).`,
      "Run `basou refresh` before starting work.",
    ],
    verdictUpdatedOnly: (n) => [
      `⚠️ ${n} session(s) have been updated. \`basou refresh\` can import them.`,
      "(A session still in progress keeps growing after each import, so it will keep appearing here — that is normal.)",
    ],
    verdictSuspectsAlso: (n) =>
      `There are also ${n} suspect session(s) (see "Suspect sessions" above).`,
    verdictEmpty: [
      "ℹ️ No records yet.",
      "Work in this workspace and your current position will appear here.",
    ],
    verdictUnprobed: (rel, tool) => [
      `ℹ️ Showing the last imported state. Last work: ${rel} (${tool}).`,
      "Run `basou refresh` to confirm this is current.",
    ],
    verdictCurrent: (rel, tool, hasHosts) =>
      hasHosts
        ? `✅ The capture on this host (local) is current. Last work: ${rel} (${tool}). No uncaptured native sessions.`
        : `✅ The capture is current. Last work: ${rel} (${tool}). No uncaptured native sessions.`,
    verdictSuspectsCaveat: (n) =>
      `However, ${n} suspect session(s) need attention (see "Suspect sessions" above).`,
    verdictScopeDisclaimer:
      "Note: this verdict only checks whether captured native sessions are current and whether any are suspect. It does not detect planning-implementation drift or unrecorded decisions.",
    toolTerminal: "terminal",
    toolHuman: "manual note",
    toolImport: "another workspace",
    toolUnknown: "unknown",
  },
  handoff: {
    headingCurrentState: "## Current state",
    headingRecentFiles: "## Recently changed files",
    headingLatestDecision: "## Latest decision",
    headingOpenTracks: "## Open tracks (shown until closed)",
    headingUnresolved: "## Unresolved items",
    headingReadNext: "## Files to read next",
    headingNextWork: "## Work to do next",
    headingSessions: "## Sessions",
    lastTaskLabel: "Last task",
    decisionStaleNote:
      "Note: the latest activity postdates this decision. It may already be resolved in conversation — confirm the continuation point before resuming (conversational decisions are not captured automatically; record them with `basou decision capture`).",
    trackCloseInstruction: "When finished, close it with `basou decision void <decision_id>`.",
  },
  decisions: {
    dateLabel: "date",
    trackKindLine: "- kind: track (stays in orient/handoff until closed)",
    decisionLabel: "decision",
  },
  report: {
    headingSummary: "## Summary",
    headingVolume: "## Work volume",
    headingDecisions: "## Decisions",
    headingApprovals: "## Approvals",
    headingTasks: "## Tasks",
    headingChangedFiles: "## Changed files",
    headingSessions: "## Sessions",
    headingIntegrity: "## Integrity",
  },
};

// E-5: the Japanese generated-view chrome. These values must stay
// byte-identical to the pre-i18n renderer output so a workspace that declares
// `language: ja` on its anchor renders exactly what it rendered before.
const JA: ViewStrings = {
  relativeAge: relativeAgeJa,
  common: {
    lastSessionLabel: "最終 session",
    latestDecisionLabel: "直近の判断",
    recentFilesLabel: "直近の変更ファイル",
    trackWhyLabel: "理由",
    decisionOtherSessionNote: (sid) =>
      `注: この判断は最終 session とは別の session [${sid}] のものです。`,
  },
  orientation: {
    headingWhere: "## 今どこにいる",
    headingRecent: (n) => `## 最近の流れ (直近 ${n} session)`,
    headingInFlight: "## 何が動く",
    headingForward: "## どこへ向かう",
    headingCurrency: "## これは最新か",
    inFlightTasksHeading: (n) => `### 進行中 task (${n})`,
    pendingApprovalsHeading: (n) => `### 承認待ち (${n})`,
    suspectSessionsHeading: (n) => `### 要注意 session (${n})`,
    openTracksHeading: (n) => `### 未完トラック (close まで継続表示) (${n})`,
    decisionStaleNote: (age) =>
      `注: これは最後に「記録された」判断です。最終活動 (${age}) はこれより後のため、現在の方針が反映されていない可能性があります(会話での意思決定は自動記録されません。\`basou decision capture\` でこの session の判断を記録できます)。`,
    outOfRootWarning: (count, files) =>
      `⚠ source_roots 外 ${count} 件 (別プロジェクトの可能性): ${files}`,
    recentEmpty: "(まだ記録がありません)",
    recentDecisionsLabel: "判断",
    recentNextStepLabel: "次の起点",
    recentChangedLabel: "変更",
    trackCloseInstruction:
      "完了したら `basou decision void <decision_id>` で閉じてください。閉じるまで毎回ここに表示されます。",
    nextStepRecordedLabel: (age) => `次の起点 (記録済み, ${age})`,
    noteStaleNote: (age) =>
      `注: この起点の記録後 (最終活動 ${age}) も作業が続いています。再開点が古い可能性があります。`,
    fallbackStaleDirection:
      "- (no planned tasks or recorded next step — 最終活動は直近の判断より後です。継続点をユーザに確認してください)",
    fallbackStaleReferenceLabel: "参考 (古い可能性・方針ではない)",
    trackNudge:
      '次に作るべき本質的な方向性が定まったら `basou decision capture` (`"kind":"track"`) / `basou decision record --track` で track 化すると、close まで毎 session ここに継続表示されます。',
    federatedFreshnessNote:
      "注: 鮮度判定はこのマシンのローカルストアのみが対象です。他ホストの取りこぼしは判定できません(各ホストで basou refresh を実行し同期してください)。",
    bannerUnverifiable: (n) =>
      `> ⚠️ **再取り込みが必要** — native ログが変化したが通常の refresh では取り込めないセッションが ${n} 件あります。\`basou refresh --force\` で再取り込みしてください(詳細は末尾「これは最新か」)。`,
    bannerStale: (parts) =>
      `> ⚠️ **古いです（未取り込み ${parts}）** — 着手前に必ず \`basou refresh\` を実行してください(詳細は末尾「これは最新か」)。`,
    partNew: (n) => `新規 ${n} 件`,
    partUpdated: (n) => `更新 ${n} 件`,
    partsJoiner: "・",
    verdictUnverifiable: (n) => [
      `⚠️ native ログが変化しましたが、通常の \`basou refresh\` では安全に再取り込みできないセッションが ${n} 件あります(非追記変更・前チェーン不整合など)。`,
      "`basou refresh --force` で再取り込みしてください。(`basou verify` は別物=取り込み済みデータの改竄/破損検査で、ヘッダの suspect とは別軸です。verify が clean でも未取り込みは残り得ます。)",
    ],
    verdictStale: (parts) => [
      `⚠️ 古いです。最後の取り込み以降に未取り込みの作業があります(${parts})。`,
      "着手前に必ず `basou refresh` を実行してください。",
    ],
    verdictUpdatedOnly: (n) => [
      `⚠️ 更新されたセッションが ${n} 件あります。\`basou refresh\` で取り込めます。`,
      "(進行中のセッションがある場合、それ自身は取り込み後も増え続けるため残ります＝正常です。)",
    ],
    verdictSuspectsAlso: (n) =>
      `また要注意セッションが ${n} 件あります(上記「要注意 session」参照)。`,
    verdictEmpty: [
      "ℹ️ まだ記録がありません。",
      "このワークスペースで作業すると、ここに現在地が表示されます。",
    ],
    verdictUnprobed: (rel, tool) => [
      `ℹ️ 取り込み済みの状態を表示しています。最後の作業は ${rel}(${tool})。`,
      "最新か確認するには `basou refresh` を実行してください。",
    ],
    verdictCurrent: (rel, tool, hasHosts) =>
      `✅ ${hasHosts ? "このホスト(ローカル)の" : ""}取り込みは最新です。最後の作業は ${rel}(${tool})。未取り込みの native セッションはありません。`,
    verdictSuspectsCaveat: (n) =>
      `ただし要注意セッションが ${n} 件あります(上記「要注意 session」参照)。`,
    verdictScopeDisclaimer:
      "注: この判定は取り込み済み native セッションの鮮度と suspect の有無だけを見ます。計画↔実装のドリフトや未記録の意思決定までは検知しません。",
    toolTerminal: "ターミナル",
    toolHuman: "手動メモ",
    toolImport: "他ワークスペース",
    toolUnknown: "不明",
  },
  handoff: {
    headingCurrentState: "## 現在の状態",
    headingRecentFiles: "## 直近の変更ファイル",
    headingLatestDecision: "## 直近の判断",
    headingOpenTracks: "## 未完トラック (close まで継続表示)",
    headingUnresolved: "## 未決事項",
    headingReadNext: "## 次に読むべきファイル",
    headingNextWork: "## 次に実行すべき作業",
    headingSessions: "## セッション一覧",
    lastTaskLabel: "最終 task",
    decisionStaleNote:
      "注: 最終活動はこの判断より後です。会話で既に解決済みの可能性があるため、再開前に継続点を確認してください(会話での意思決定は自動記録されません。`basou decision capture` で記録できます)。",
    trackCloseInstruction: "完了したら `basou decision void <decision_id>` で閉じてください。",
  },
  decisions: {
    dateLabel: "決定日",
    trackKindLine: "- 種別: track (close まで orient/handoff に継続表示)",
    decisionLabel: "判断",
  },
  report: {
    headingSummary: "## 概要",
    headingVolume: "## 作業量",
    headingDecisions: "## 判断",
    headingApprovals: "## 承認",
    headingTasks: "## タスク",
    headingChangedFiles: "## 変更ファイル",
    headingSessions: "## セッション一覧",
    headingIntegrity: "## 整合性",
  },
};
