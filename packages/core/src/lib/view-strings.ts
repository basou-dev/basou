import { normalizeRelativePath } from "../project/relative-path.js";
import type { PublishTarget, RepoLanguage, RepoVisibility } from "../project/roster.js";
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
 * This module is the SINGLE home for generated Japanese — the view chrome here
 * and the instruction-file content in {@link PresetStrings} (the E-5
 * language-lint allowlist points here, not at the renderers/generators), so
 * "user data language" and "tool-generated content language" can never blur
 * together again.
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
    /**
     * Body line under the in-flight-tasks heading when NO task was ever
     * recorded here. "(none)" states that nothing is pending — a claim about
     * the work. This one claims only what it can see: that the record is
     * empty. It says nothing about whether the workspace should use tasks,
     * and names no command: the renderers report position, and a nudge that
     * cannot be silenced is noise (see `trackNudge`, which is gated).
     */
    noTasksRecorded: string;
    /**
     * Body line under the in-flight-tasks heading when tasks ARE on record
     * here and every one of them parsed, with none open. A bare "(none)" is
     * literally true and still misread: it answers "is anything in flight?"
     * with a word that sounds like "nothing is happening". Work can be under
     * way and simply not filed as a task. This line leads with what the
     * record does hold, so it cannot be skimmed as its sibling below, and it
     * claims nothing about the work.
     */
    noTasksInFlight: string;
    /**
     * Same heading, but a task file could not be read on THIS pass, so its
     * status is unknown and "none in flight" would be an assertion the
     * renderer cannot support. Says what it can see and stops.
     *
     * A standing condition, not a one-pass report: it holds every render until
     * the file is repaired or removed. It used to give way to its sibling on
     * the second render, because rebuilding the task index dropped the file it
     * could not parse and nothing enumerated it again.
     */
    tasksUnreadable: string;
    /**
     * Appended under a NON-empty in-flight list when some task file could not
     * be read.
     *
     * The list above it is true and incomplete at the same time, and a reader
     * has no way to tell from a heading count that anything is missing. The
     * zero case already says so; saying nothing here would make "unreadable" a
     * fact basou reports only when it happens to have nothing else to report.
     */
    tasksUnreadableAlongside: (n: number) => string;
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
    /** Trails the recent-files line when scratch paths were left out of it. */
    scratchOmitted: (count: number) => string;
    trackCloseInstruction: string;
    /** Forward-section pointer to `basou decision gaps`; omitted when the count is 0. */
    decisionGapsLine: (n: number) => string;
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
    /**
     * The line saying the workspace keeps a progress board: when its last
     * record was written (null when there is none, undefined when the
     * records cannot be read), the axis's version (null when it cannot be
     * read), and how to update it.
     */
    boardLine: (
      last: { date: string; age: string } | null | undefined,
      axisVersion: number | null,
    ) => string;
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
    /** "Work to do next" placeholder: tasks exist, none are open. */
    noPendingTasks: string;
    /** "Work to do next" placeholder: no task was ever recorded. */
    noTasksRecorded: string;
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

// How the position's progress-board line begins and ends in each language.
// Between them stand only a date, an age and a version, which basou writes.
const BOARD_LINE = {
  en: { head: "Progress board: ", tail: ". To update it, follow `basou board guide`." },
  ja: { head: "進捗盤: ", tail: "。更新は `basou board guide` の手順で。" },
} as const;

/**
 * Whether a line of a position is the progress-board line, as a bullet:
 * fixed words of basou's around a date, an age and a version, which carry no
 * name of the operator's. A scan for other workspaces' names passes it over,
 * so a workspace named like one of its words does not silence a position.
 */
export function isPositionBoardLine(line: string): boolean {
  return Object.values(BOARD_LINE).some(
    ({ head, tail }) =>
      line.startsWith(`- ${head}`) &&
      line.endsWith(tail) &&
      !line.slice(2 + head.length, line.length - tail.length).includes("`"),
  );
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
    noTasksRecorded: "(no tasks recorded)",
    noTasksInFlight: "(tasks on record, none in flight)",
    tasksUnreadable: "(tasks on record, some unreadable -- in flight unknown)",
    tasksUnreadableAlongside: (n) =>
      n === 1
        ? "(and 1 task file could not be read -- what it holds is unknown)"
        : `(and ${n} task files could not be read -- what they hold is unknown)`,
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
    scratchOmitted: (count) => `(+${count} scratch omitted)`,
    trackCloseInstruction:
      "When finished, close it with `basou decision void <decision_id>`. It stays listed here every time until closed.",
    decisionGapsLine: (n) =>
      `${n} recorded decision${n === 1 ? "" : "s"} ${n === 1 ? "has" : "have"} no task carrying ${n === 1 ? "it" : "them"} — list ${n === 1 ? "it" : "them"} with \`basou decision gaps\`.`,
    nextStepRecordedLabel: (age) => `Next step (recorded, ${age})`,
    noteStaleNote: (age) =>
      `Note: work continued after this was recorded (latest activity ${age}), so this starting point may be stale.`,
    fallbackStaleDirection:
      "- (no planned tasks or recorded next step — the latest activity postdates the latest decision; ask the user for the continuation point)",
    fallbackStaleReferenceLabel: "Reference (possibly stale — not the current direction)",
    trackNudge:
      'Once the next essential direction is settled, record it as a track: `basou decision capture` with `"kind":"track"` (the batch form, piped as JSON), or `basou decision record --track` for a single one typed by hand — it stays surfaced here every session until closed.',
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
    boardLine: (last, axisVersion) => {
      const record =
        last === undefined
          ? "its records cannot be read"
          : last === null
            ? "no record yet"
            : `last record ${last.date} (${last.age})`;
      const axis = axisVersion === null ? "axis version unknown" : `axis v${axisVersion}`;
      return `${BOARD_LINE.en.head}${record}, ${axis}${BOARD_LINE.en.tail}`;
    },
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
    noPendingTasks: "(no pending tasks)",
    noTasksRecorded: "(no tasks recorded)",
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
    noTasksRecorded: "(task が 1 件も記録されていません)",
    noTasksInFlight: "(記録済みの task はありますが、進行中はありません)",
    tasksUnreadable: "(記録済みの task に読めないものがあり、進行中かは不明です)",
    tasksUnreadableAlongside: (n) => `(ほかに読めない task ファイルが ${n} 件あり、内容は不明です)`,
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
    scratchOmitted: (count) => `(作業用一時ファイル ${count} 件は除外)`,
    trackCloseInstruction:
      "完了したら `basou decision void <decision_id>` で閉じてください。閉じるまで毎回ここに表示されます。",
    decisionGapsLine: (n) =>
      `task が紐づいていない判断が ${n} 件あります — \`basou decision gaps\` で一覧できます。`,
    nextStepRecordedLabel: (age) => `次の起点 (記録済み, ${age})`,
    noteStaleNote: (age) =>
      `注: この起点の記録後 (最終活動 ${age}) も作業が続いています。再開点が古い可能性があります。`,
    fallbackStaleDirection:
      "- (no planned tasks or recorded next step — 最終活動は直近の判断より後です。継続点をユーザに確認してください)",
    fallbackStaleReferenceLabel: "参考 (古い可能性・方針ではない)",
    trackNudge:
      '次に作るべき本質的な方向性が定まったら track 化すると、close まで毎 session ここに継続表示されます。まとめて JSON で渡すなら `basou decision capture` に `"kind":"track"` を、手で 1 件書くなら `basou decision record --track` を使ってください。',
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
    boardLine: (last, axisVersion) => {
      const record =
        last === undefined
          ? "記録が読めない"
          : last === null
            ? "記録なし"
            : `最後の記録 ${last.date}（${last.age}）`;
      const axis = axisVersion === null ? "軸の版は不明" : `軸 v${axisVersion}`;
      return `${BOARD_LINE.ja.head}${record}・${axis}${BOARD_LINE.ja.tail}`;
    },
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
    noPendingTasks: "(未完了の task はありません)",
    noTasksRecorded: "(task が 1 件も記録されていません)",
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

/**
 * Resolve a GENERATED INSTRUCTION-FILE's content language from the target
 * repo's declared `language`. Unlike the views (workspace-level artifacts that
 * follow the anchor), a preset block lives inside one repo's instruction file,
 * so its audience is that repo's declared audience: `ja` renders Japanese
 * (byte-identical to the pre-i18n output), `en` / `en+ja` / undeclared render
 * English (one content language per generated block; en is the shared floor).
 */
export function resolveRepoContentLanguage(language: RepoLanguage | undefined): ViewLanguage {
  return language === "ja" ? "ja" : "en";
}

/**
 * Resolve the content language of a WORKSPACE-LEVEL instruction artifact (the
 * view's AGENTS.md block, the anchor's starter) from an already-gathered
 * roster: the entry flagged `anchor` speaks for the workspace, mirroring the
 * views' anchor-language rule. No anchor entry (or no declared language)
 * resolves to English. When more than one entry carries the flag, the first
 * wins (declared order).
 *
 * Note the anchor is identified by the CALLER-SET flag, not by this module:
 * {@link resolveViewLanguage} keys on the manifest path being `.`, while the
 * instruction-file callers flag the anchor by resolved-path identity. For a
 * conventional manifest (anchor declared as `.`) the two agree; a roster that
 * reaches the anchor only through an aliased path is where they can diverge,
 * and the caller's flag is authoritative for the instruction files.
 */
export function resolveAnchorContentLanguage(
  repos: ReadonlyArray<{ anchor?: boolean | undefined; language?: RepoLanguage | undefined }>,
): ViewLanguage {
  return resolveRepoContentLanguage(repos.find((r) => r.anchor === true)?.language);
}

/**
 * Every localized string the instruction-file generators emit: the per-repo
 * preset block, the workspace view's block, and the anchor's starter. Lives in
 * this module for the same reason as {@link ViewStrings}: it is the SINGLE
 * home for generated Japanese, so the language-lint E-5 allowlist stays one
 * file and "generated content language" is always a declaration-driven table
 * lookup, never a hardcode.
 */
export type PresetStrings = {
  repoBlock: {
    heading: string;
    intro: string;
    /** Source git-visibility, rendered with the consequence the agent must respect. */
    visibilityLabel: (v: RepoVisibility | undefined) => string;
    /**
     * Source language (commits/comments/code), rendered with the audience it
     * serves. Invariant note: the table itself is SELECTED by this same field
     * (ja -> JA table, everything else -> EN), so the JA table's en / en+ja /
     * unset branches and the EN table's ja branch are unreachable from
     * renderPresetBlock — they exist for table completeness (and the
     * both-language sweep test), not because a render can emit them.
     */
    sourceLanguageLabel: (l: RepoLanguage | undefined) => string;
    /** Published-surface kind. */
    publishKindLabel: (k: PublishTarget["kind"]) => string;
    /** A published surface's visibility (independent of the source repo's). */
    publishVisibilityLabel: (v: RepoVisibility | undefined) => string;
    /** A published surface's content language (read by end users; may differ from source). */
    contentLanguageLabel: (l: RepoLanguage | undefined) => string;
    /** "ソース可視性" — the source-visibility line label. */
    sourceVisibilityLabel: string;
    /** "ソース言語" — the source-language line label. */
    sourceLanguageLineLabel: string;
    /** "- 配信物: なし" — no published surfaces. */
    publishesNone: string;
    /** "- 配信物:" — the published-surfaces list header. */
    publishesHeader: string;
  };
  viewBlock: {
    heading: string;
    intro: string;
    selfNote: (viewName: string) => string;
    aggregates: (repoCount: number) => string;
    reposHeading: string;
    tableHeader: string;
    /** Instruction-file ownership labels: who writes the repo's AGENTS.md. */
    instructionsAnchor: string;
    instructionsSelf: string;
    instructionsHub: string;
    /** "未設定" — the short table cell for an undeclared visibility / language. */
    unsetShort: string;
    commitHeading: string;
    commitBody: string;
    conventionsHeading: string;
    conventionsBody: string;
    /** Heading for {@link handoffPointer}. Its own, so the pointer is not filed
     * under "Required reading" while telling the reader not to read it through. */
    handoffHeading: string;
    /**
     * Where the session roster lives. One line, because the adjudication that
     * chose this destination capped session-start injection: the roster itself
     * must never be injected, only its address.
     */
    handoffPointer: string;
    principlesHeading: string;
    principleStateless: string;
    principleNoFiles: string;
  };
  anchorStarter: {
    identityLine: (title: string) => string;
    starterNote: string;
    basicsHeading: string;
    basicsTodo: string;
    commitHeading: string;
    commitPlanning: string;
    commitImplementation: string;
    commitView: string;
    conventionsHeading: string;
    conventionsBody: string;
    viewPointerLine: (viewName: string) => string;
    /** Same route as the view block's, for the anchor — which is where `.basou/` lives. */
    handoffHeading: string;
    handoffPointer: string;
    policyHeading: string;
    policyTodo: string[];
  };
};

/** Look up the instruction-file string table for a resolved content language. */
export function presetStrings(language: ViewLanguage): PresetStrings {
  return language === "ja" ? PRESET_JA : PRESET_EN;
}

const PRESET_EN: PresetStrings = {
  repoBlock: {
    heading: "## Project configuration (generated by basou — the manifest is the source of truth)",
    intro:
      "This section is generated by `basou project preset` from the declarations in `.basou/manifest.yaml`. Edit the manifest, not this block (content outside the markers is preserved).",
    visibilityLabel: (v) => {
      switch (v) {
        case "public":
          return "public (the git history is public)";
        case "private":
          return "private (the git history is not public)";
        case "future-public":
          return "future-public (private today, planned to go public)";
        default:
          return "unset";
      }
    },
    sourceLanguageLabel: (l) => {
      switch (l) {
        case "en":
          return "en (commits, comments, and code in English)";
        case "ja":
          return "ja (commits, comments, and code in Japanese)";
        case "en+ja":
          return "en+ja (commits, comments, and code in English and Japanese)";
        default:
          return "unset";
      }
    },
    publishKindLabel: (k) => (k === "web" ? "web (deployed)" : "npm (package)"),
    publishVisibilityLabel: (v) => {
      switch (v) {
        case "public":
          return "public";
        case "private":
          return "private";
        case "future-public":
          return "future-public";
        default:
          return "visibility unset";
      }
    },
    contentLanguageLabel: (l) => l ?? "language unset",
    sourceVisibilityLabel: "Source visibility",
    sourceLanguageLineLabel: "Source language",
    publishesNone: "- Published surfaces: none",
    publishesHeader: "- Published surfaces:",
  },
  viewBlock: {
    heading: "## Workspace view layout (generated by basou — the manifest is the source of truth)",
    intro:
      "This section is generated by `basou project preset` from the declarations in `.basou/manifest.yaml`. Edit the manifest, not this block (content outside the markers is preserved).",
    selfNote: (viewName) =>
      `This AGENTS.md is itself generated by basou (canonical: \`agents/${viewName}/AGENTS.md\`; content outside the markers is preserved).`,
    aggregates: (n) =>
      `This directory is a **view** aggregating the ${n} declared repo(s) via symlinks. It holds no content of its own and is not under git.`,
    reposHeading: "### Aggregated repos",
    tableHeader: "| repo | visibility | language | instructions |",
    instructionsAnchor: "anchor (hand-maintained)",
    instructionsSelf: "self (the repo owns it)",
    instructionsHub: "hub (generated by basou)",
    unsetShort: "unset",
    commitHeading: "### Where to commit",
    commitBody:
      "You cannot commit in the view (it is not under git). Always `cd` into the actual repo before committing.",
    conventionsHeading: "### Required reading",
    conventionsBody:
      "The working conventions live in each repo's AGENTS.md. Read these before working.",
    handoffHeading: "### Looking something up",
    handoffPointer:
      "For which session did what and when, consult the session roster in `.basou/handoff.md` (`basou handoff generate` refreshes it, and works from here). Consult it; do not read the file through — the roster is most of it. `basou orient` answers where the work stands and shows only the newest few sessions.",
    principlesHeading: "### Key principles",
    principleStateless: "- This directory holds no state (not under git)",
    principleNoFiles: "- Do not place important files here directly (they belong in the repos)",
  },
  anchorStarter: {
    identityLine: (title) =>
      `> This repository is the **planning master (anchor) of ${title}**. AI agents working here should read this file first.`,
    starterNote:
      "> This file is a starter that `basou project derive` generated **once** at greenfield bring-up. Hand-maintain it from here — basou never regenerates or overwrites it (there are no BASOU:GENERATED markers; edit freely).",
    basicsHeading: "## Project basics",
    basicsTodo: "<!-- TODO: these cannot be derived from the manifest. Fill them in. -->",
    commitHeading: "## Where to commit",
    commitPlanning: "- **This repository (the planning master)**: plans, designs, strategy docs.",
    commitImplementation:
      "- **Each implementation repo**: implementation code. Always `cd` into the target repo before committing.",
    commitView: "- **The workspace view**: not under git. You cannot commit in the view.",
    conventionsHeading: "## Required reading",
    conventionsBody:
      "The working conventions live in each repo's AGENTS.md. Read these before working.",
    viewPointerLine: (viewName) =>
      `- ${viewName}/AGENTS.md (the workspace view, generated by basou) — **the authoritative, up-to-date repo roster (the live roster) lives there**`,
    handoffHeading: "## Looking something up",
    handoffPointer:
      "For which session did what and when, consult the session roster in `.basou/handoff.md` (`basou handoff generate` refreshes it). Consult it; do not read the file through — the roster is most of it. `basou orient` answers where the work stands and shows only the newest few sessions.",
    policyHeading: "## Working policy (project specifics)",
    policyTodo: [
      "<!-- TODO: describe these for your project.",
      "  - Current phase / key documents",
      "  - Secrets handling (where NOT to write them)",
      "  - Language policy (commits / comments / docs)",
      "  - Commit discipline (avoid mixed commits, etc.)",
      "-->",
    ],
  },
};

// E-5: the Japanese instruction-file content. These values must stay
// byte-identical to the pre-i18n generator output so a repo that declares
// `language: ja` (or a ja anchor, for the view/starter) renders exactly what
// it rendered before.
const PRESET_JA: PresetStrings = {
  repoBlock: {
    heading: "## プロジェクト構成(basou が生成 — manifest が正本)",
    intro:
      "このセクションは `.basou/manifest.yaml` の宣言から `basou project preset` が生成します。編集は manifest 側で行ってください(マーカー外の記述は保持されます)。",
    visibilityLabel: (v) => {
      switch (v) {
        case "public":
          return "public(git 履歴は公開)";
        case "private":
          return "private(git 履歴は非公開)";
        case "future-public":
          return "future-public(現在は非公開・将来公開予定)";
        default:
          return "未設定";
      }
    },
    sourceLanguageLabel: (l) => {
      switch (l) {
        case "en":
          return "en(commit・コメント・コードは英語)";
        case "ja":
          return "ja(commit・コメント・コードは日本語)";
        case "en+ja":
          return "en+ja(commit・コメント・コードは日英)";
        default:
          return "未設定";
      }
    },
    publishKindLabel: (k) => (k === "web" ? "web(デプロイ)" : "npm(パッケージ)"),
    publishVisibilityLabel: (v) => {
      switch (v) {
        case "public":
          return "公開";
        case "private":
          return "非公開";
        case "future-public":
          return "将来公開";
        default:
          return "可視性未設定";
      }
    },
    contentLanguageLabel: (l) => l ?? "言語未設定",
    sourceVisibilityLabel: "ソース可視性",
    sourceLanguageLineLabel: "ソース言語",
    publishesNone: "- 配信物: なし",
    publishesHeader: "- 配信物:",
  },
  viewBlock: {
    heading: "## workspace view 構成(basou が生成 — manifest が正本)",
    intro:
      "このセクションは `.basou/manifest.yaml` の宣言から `basou project preset` が生成します。編集は manifest 側で行ってください(マーカー外の記述は保持されます)。",
    selfNote: (viewName) =>
      `この AGENTS.md 自身も basou の生成物です(実体: \`agents/${viewName}/AGENTS.md\`、マーカー外の記述は保持されます)。`,
    aggregates: (n) =>
      `このディレクトリは、宣言された ${n} 個の repo を symlink で集約する **view** です。実体を持たず、git 管理外です。`,
    reposHeading: "### 集約している repo",
    tableHeader: "| repo | 可視性 | 言語 | 指示書 |",
    instructionsAnchor: "anchor(手管理)",
    instructionsSelf: "self(repo が自己管理)",
    instructionsHub: "hub(basou が生成)",
    unsetShort: "未設定",
    commitHeading: "### どこで commit するか",
    commitBody:
      "view では commit できません(git 管理外)。変更は必ず実体の repo に `cd` してから commit してください。",
    conventionsHeading: "### 必ず読むべき規約",
    conventionsBody:
      "作業規約は各 repo の AGENTS.md にあります。以下を読んでから作業してください。",
    handoffHeading: "### 調べるとき",
    handoffPointer:
      "どのセッションが何をいつやったかは、`.basou/handoff.md` のセッション一覧を参照してください(`basou handoff generate` で更新でき、ここからでも動きます)。通読せず参照してください — 大半がその一覧です。`basou orient` は現在地を答え、直近数件しか出しません。",
    principlesHeading: "### 重要原則",
    principleStateless: "- このディレクトリは状態を持たない(git 管理外)",
    principleNoFiles: "- 重要なファイルをここに直接置かない(実体は各 repo に置く)",
  },
  anchorStarter: {
    identityLine: (title) =>
      `> このリポジトリは **${title} の planning master(anchor)** です。ここで作業する AI エージェントは、まずこのファイルを読んでください。`,
    starterNote:
      "> このファイルは `basou project derive` が greenfield 立ち上げ時に **一度だけ生成した starter** です。以後は手管理してください — basou は再生成も上書きもしません(BASOU:GENERATED マーカーは無く、自由に編集できます)。",
    basicsHeading: "## プロジェクトの基本情報",
    basicsTodo: "<!-- TODO: manifest からは導出できない項目です。埋めてください。 -->",
    commitHeading: "## どこで commit するか",
    commitPlanning: "- **このリポジトリ(planning master)**: 構想・計画・設計ドキュメント。",
    commitImplementation:
      "- **各実装 repo**: 実装コード。必ず対象 repo に `cd` してから commit してください。",
    commitView: "- **workspace view**: git 管理外。view では commit できません。",
    conventionsHeading: "## 必ず読むべき規約",
    conventionsBody:
      "作業規約は各 repo の AGENTS.md にあります。以下を読んでから作業してください。",
    viewPointerLine: (viewName) =>
      `- ${viewName}/AGENTS.md(workspace view・basou が生成)— **最新の repo 構成(roster)はここを正とする**`,
    handoffHeading: "## 調べるとき",
    handoffPointer:
      "どのセッションが何をいつやったかは、`.basou/handoff.md` のセッション一覧を参照してください(`basou handoff generate` で更新)。通読せず参照してください — 大半がその一覧です。`basou orient` は現在地を答え、直近数件しか出しません。",
    policyHeading: "## 作業方針(プロジェクト固有事項)",
    policyTodo: [
      "<!-- TODO: 以下をプロジェクトに合わせて記述してください。",
      "  - 現在のフェーズ / 重要ドキュメント",
      "  - 機密情報の扱い(どこに書かないか)",
      "  - 言語ポリシー(commit / コメント / ドキュメントの言語)",
      "  - commit 運用(混在コミットを避ける 等)",
      "-->",
    ],
  },
};

/**
 * The fixed strings of the board page of `basou view`, as plain text so that
 * the server can hand them to the page as JSON. A `{name}` in one is filled in
 * by the page. What a board declares or a record holds (lane names, the
 * meanings of stages, prose) is the user's data and is never translated.
 */
export type BoardPageStrings = {
  pageTitle: string;
  latest: string;
  older: string;
  newer: string;
  loadFailed: string;
  /** Marks what the judge reported, as against what basou measured. */
  reported: string;
  heading: {
    recordedAt: string;
    judgedBy: string;
    complete: string;
    incomplete: string;
  };
  sections: {
    summary: string;
    effort: string;
    matrix: string;
    lanes: string;
    composition: string;
    turns: string;
    footnotes: string;
  };
  tiles: {
    liveLanes: string;
    liveLanesOf: string;
    blocked: string;
    unverified: string;
    openTracks: string;
    sessions: string;
    sessionsNotVerified: string;
    turns: string;
    notMeasured: string;
  };
  observed: {
    heading: string;
    name: string;
    value: string;
    observedAt: string;
    source: string;
    none: string;
    missing: string;
    missingNoPrevious: string;
    missingPreviousUnreadable: string;
  };
  effort: {
    elapsed: string;
    days: string;
    from: string;
    fromZone: string;
    active: string;
    daysWorked: string;
    claude: string;
    codex: string;
    noCodex: string;
    perDay: string;
    perDayWorked: string;
    outputTokens: string;
    withoutTokens: string;
    commits: string;
    milestones: string;
    noMilestones: string;
    notMeasured: string;
    dailyTitle: string;
    notClaude: string;
    dayDetail: string;
    cumulativeTitle: string;
    cumulativeDetail: string;
    weeksTitle: string;
    week: string;
    weekOf: string;
    activeDays: string;
    commitColumn: string;
    noDays: string;
  };
  states: {
    done: string;
    part: string;
    blocked: string;
    shelved: string;
    none: string;
    unverified: string;
  };
  matrix: {
    lane: string;
    moved: string;
    anomalies: string;
    anomaly: string;
  };
  lane: {
    now: string;
    notStarted: string;
    attention: string;
    measures: string;
    live: string;
    blocked: string;
    unverified: string;
  };
  composition: { none: string };
  turns: { none: string; source: string };
  footnotes: {
    axis: string;
    lastReview: string;
    lastReviewFromRecord: string;
    noReview: string;
    reviewUnknown: string;
    reviewNeeded: string;
    reviewNeededYes: string;
    reviewNeededNo: string;
    reviewNeededUnknown: string;
    /** In place of lastReview and the rest when the record reviews the axis itself. */
    previousReview: string;
    previousReviewFromRecord: string;
    noPreviousReview: string;
    previousReviewUnknown: string;
    reviewNeededBefore: string;
    /** Followed by the review's summary. */
    thisReview: string;
    judgedBy: string;
    reportedNote: string;
    notMeasured: string;
    measuredWith: string;
  };
  unavailable: {
    noBoard: string;
    noRecords: string;
    recordsNotDirectory: string;
    recordsUnreadable: string;
    notFound: string;
    notJson: string;
    unknownVersion: string;
    notARecord: string;
  };
  /** The board measured on the spot, with no record: what basou measures, nothing judged. */
  live: {
    measureNow: string;
    toRecords: string;
    measuring: string;
    remeasure: string;
    measuredAt: string;
    repos: string;
    repo: string;
    branch: string;
    head: string;
    lastCommit: string;
    commits: string;
    uncommitted: string;
    behindMain: string;
    trail: string;
    decisions: string;
    decisionsAll: string;
    reviewGaps: string;
    newestSession: string;
    noSession: string;
    unimported: string;
    unimportedNotMeasured: string;
    byStatus: string;
    byVerdict: string;
    tracks: string;
    noTracks: string;
    components: string;
    noComponents: string;
    note: string;
    judged: string;
  };
};

const BOARD_PAGE_EN: BoardPageStrings = {
  pageTitle: "Progress board",
  latest: "Latest",
  older: "Older record",
  newer: "Newer record",
  loadFailed: "The board could not be loaded: {message}",
  reported: "reported",
  heading: {
    recordedAt: "Recorded {at}",
    judgedBy: "judged by {model}",
    complete: "everything was measured",
    incomplete: "{n} could not be measured",
  },
  sections: {
    summary: "Summary",
    effort: "Period and effort",
    matrix: "Reach matrix",
    lanes: "Where each lane is",
    composition: "Composition",
    turns: "The operator's turns",
    footnotes: "Footnotes",
  },
  tiles: {
    liveLanes: "Lanes in operation",
    liveLanesOf: "of {n} lanes",
    blocked: "Blocked cells",
    unverified: "Unverified cells",
    openTracks: "Open tracks",
    sessions: "Sessions in the trail",
    sessionsNotVerified: "{n} not verified",
    turns: "The operator's turns",
    notMeasured: "not measured",
  },
  observed: {
    heading: "Observed outside",
    name: "Name",
    value: "Value",
    observedAt: "Observed",
    source: "Source",
    none: "Nothing was observed outside.",
    missing: "not observed (previous: {value})",
    missingNoPrevious: "not observed (no previous value)",
    missingPreviousUnreadable: "not observed (the previous record could not be read)",
  },
  effort: {
    elapsed: "Elapsed",
    days: "{days} days",
    from: "from {date}",
    fromZone: "from {date} ({zone})",
    active: "Active",
    daysWorked: "{n} days worked",
    claude: "Claude",
    codex: "Codex",
    noCodex: "no Codex session",
    perDay: "Per day",
    perDayWorked: "{time} a day worked",
    outputTokens: "Output tokens",
    withoutTokens: "imports that recorded no tokens: {n}",
    commits: "Commits since the start: {list}",
    milestones: "Milestones",
    noMilestones: "No milestones declared.",
    notMeasured: "not measured",
    dailyTitle: "Active time by day",
    notClaude: "Not Claude (Codex, by hand, in a terminal; not at the same time as Claude)",
    dayDetail: "{date}: active {active} (Claude {claude}, not Claude {other}), commits {commits}",
    cumulativeTitle: "Active time, cumulative",
    cumulativeDetail: "{date}: {total} in all",
    weeksTitle: "By week, from Monday",
    week: "Week",
    weekOf: "week of {date}",
    activeDays: "Days worked",
    commitColumn: "Commits",
    noDays: "There are no days to draw.",
  },
  states: {
    done: "done",
    part: "partly",
    blocked: "blocked",
    shelved: "shelved",
    none: "not started",
    unverified: "unverified",
  },
  matrix: {
    lane: "Lane",
    moved: "was {state} in the previous record",
    anomalies: "Out of order",
    anomaly: "{lane} {stage} is {state} before {before}, which is done or begun",
  },
  lane: {
    now: "Now at {stage} {meaning} ({state})",
    notStarted: "No stage done or begun",
    attention: "Blocked, shelved or unverified",
    measures: "Measured",
    live: "in operation",
    blocked: "blocked",
    unverified: "has unverified cells",
  },
  composition: { none: "No ratios are declared." },
  turns: { none: "Nothing is waiting on the operator.", source: "source: {source}" },
  footnotes: {
    axis: "Axis v{version}",
    lastReview: "last reviewed {date} by {model} (declared)",
    lastReviewFromRecord: "last reviewed {date} by {model} (record {record})",
    noReview: "no review on record",
    reviewUnknown: "the last review is not known (a record that may hold it could not be read)",
    reviewNeeded: "Review needed: {answer}",
    reviewNeededYes: "yes",
    reviewNeededNo: "no",
    reviewNeededUnknown: "not known",
    previousReview: "previous review {date} by {model} (declared)",
    previousReviewFromRecord: "previous review {date} by {model} (record {record})",
    noPreviousReview: "no review before this one on record",
    previousReviewUnknown:
      "the previous review is not known (a record that may hold it could not be read)",
    reviewNeededBefore: "Review needed before this record: {answer}",
    thisReview: "This record reviews the axis (triggers: {triggers}): ",
    judgedBy: "The cells and prose were written by {model}, as it reported itself.",
    reportedNote:
      "Marked reported: what the judge wrote (cells, prose and observations outside). Everything else was measured by basou.",
    notMeasured: "Not measured",
    measuredWith: "Measured with basou {basou}{build}.",
  },
  unavailable: {
    noBoard:
      "The board page shows the records beside board/board.yaml in the workspace, which is read only when the manifest declares this workspace's own repo (path: .) private.",
    noRecords:
      "The board has no record yet. Declare the board in board/board.yaml and write a record with basou board record; it is drawn here.",
    recordsNotDirectory:
      "The records/ beside board/board.yaml is not a directory (a symlink or a file).",
    recordsUnreadable: "The records/ beside board/board.yaml could not be read.",
    notFound: "There is no record {record}.",
    notJson: "The record {record} could not be read as JSON.",
    unknownVersion:
      "The record {record} is of record_version {version}, which this basou does not draw.",
    notARecord: "The record {record} is not in the shape of a record.",
  },
  live: {
    measureNow: "Measure now",
    toRecords: "Recorded board",
    measuring: "Measuring the workspace...",
    remeasure: "Measure again",
    measuredAt: "Measured {at}, on the spot (not a record)",
    repos: "Repositories",
    repo: "Repository",
    branch: "Branch",
    head: "HEAD",
    lastCommit: "Last commit",
    commits: "Commits",
    uncommitted: "Uncommitted",
    behindMain: "Behind origin/main",
    trail: "Trail",
    decisions: "Decisions",
    decisionsAll: "{n} in all, voided ones included",
    reviewGaps: "Review gaps",
    newestSession: "Newest session",
    noSession: "no session",
    unimported: "not imported: {new} new, {updated} updated, {unverifiable} unverifiable",
    unimportedNotMeasured: "sessions not imported: not measured",
    byStatus: "Sessions by basou verify status: {list}",
    byVerdict: "Units of work by basou review-gaps verdict: {list}",
    tracks: "Open tracks",
    noTracks: "No open track.",
    components: "Components",
    noComponents: "No component was found.",
    note: "basou measured these values from this workspace's repos and trail when the page was opened. They are not recorded, and nothing here is judged.",
    judged:
      "The reach matrix, the lanes and the operator's turns are drawn from a record: declare the board in board/board.yaml, have an agent judge it, and record it with basou board record.",
  },
};

const BOARD_PAGE_JA: BoardPageStrings = {
  pageTitle: "進捗盤",
  latest: "最新",
  older: "前の記録",
  newer: "次の記録",
  loadFailed: "盤を読み込めませんでした: {message}",
  reported: "申告",
  heading: {
    recordedAt: "{at} に記録",
    judgedBy: "判定 {model}",
    complete: "すべて測れた",
    incomplete: "{n} 件が測れなかった",
  },
  sections: {
    summary: "サマリー",
    effort: "期間と労力",
    matrix: "到達マトリクス",
    lanes: "レーンごとの現在地",
    composition: "構成比",
    turns: "operator の手番",
    footnotes: "脚注",
  },
  tiles: {
    liveLanes: "稼働に届いたレーン",
    liveLanesOf: "{n} レーン中",
    blocked: "止まっているセル",
    unverified: "未確認のセル",
    openTracks: "未完トラック",
    sessions: "証跡の session",
    sessionsNotVerified: "verified でないもの {n}",
    turns: "operator の手番",
    notMeasured: "測れなかった",
  },
  observed: {
    heading: "外の観測",
    name: "項目",
    value: "値",
    observedAt: "観測",
    source: "出所",
    none: "外の観測はない。",
    missing: "未確認（前回値: {value}）",
    missingNoPrevious: "未確認（前回値なし）",
    missingPreviousUnreadable: "未確認（前回の記録が読めない）",
  },
  effort: {
    elapsed: "経過",
    days: "{days} 日",
    from: "{date} から",
    fromZone: "{date} から（{zone}）",
    active: "実働",
    daysWorked: "{n} 日に分布",
    claude: "Claude",
    codex: "Codex",
    noCodex: "Codex の session なし",
    perDay: "1 日あたり",
    perDayWorked: "動いた日だけなら {time}",
    outputTokens: "出力トークン",
    withoutTokens: "トークンを記録しなかった取り込み {n}",
    commits: "開始日以降の commit: {list}",
    milestones: "節目",
    noMilestones: "節目の宣言はない。",
    notMeasured: "測れなかった",
    dailyTitle: "日ごとの実働",
    notClaude: "Claude 以外（Codex・人手・端末など。Claude と重ならない分）",
    dayDetail: "{date}: 実働 {active}（Claude {claude} / Claude 以外 {other}）· commit {commits}",
    cumulativeTitle: "実働の累積",
    cumulativeDetail: "{date}: 累計 {total}",
    weeksTitle: "週ごと（月曜から）",
    week: "週",
    weekOf: "{date} 週",
    activeDays: "動いた日",
    commitColumn: "commit",
    noDays: "描く日がない。",
  },
  states: {
    done: "到達",
    part: "部分到達",
    blocked: "止まっている",
    shelved: "棚上げ",
    none: "未着手",
    unverified: "未確認",
  },
  matrix: {
    lane: "レーン",
    moved: "前回は {state}",
    anomalies: "順序の破れ",
    anomaly: "{lane} の {stage} は {state} なのに、後の {before} は到達か部分到達",
  },
  lane: {
    now: "いまの段 {stage} {meaning}（{state}）",
    notStarted: "到達・部分到達の段はない",
    attention: "止まり・棚上げ・未確認",
    measures: "測った値",
    live: "稼働",
    blocked: "止まっている",
    unverified: "未確認あり",
  },
  composition: { none: "構成比の宣言はない。" },
  turns: { none: "operator の手番はない。", source: "出所: {source}" },
  footnotes: {
    axis: "軸 v{version}",
    lastReview: "最終見直し {date}・{model}（宣言）",
    lastReviewFromRecord: "最終見直し {date}・{model}（記録 {record}）",
    noReview: "見直しの記録なし",
    reviewUnknown: "前回の見直しは分からない（それを含みうる記録が読めない）",
    reviewNeeded: "見直しの要否: {answer}",
    reviewNeededYes: "要",
    reviewNeededNo: "不要",
    reviewNeededUnknown: "分からない",
    previousReview: "前回の見直し {date}・{model}（宣言）",
    previousReviewFromRecord: "前回の見直し {date}・{model}（記録 {record}）",
    noPreviousReview: "前回の見直しの記録なし",
    previousReviewUnknown: "前回の見直しは分からない（それを含みうる記録が読めない）",
    reviewNeededBefore: "この記録の前の見直しの要否: {answer}",
    thisReview: "この記録で軸を見直した（きっかけ: {triggers}）: ",
    judgedBy: "セルと文章を書いたのは {model}（自己申告）。",
    reportedNote:
      "「申告」の印は、判定したモデルが書いたもの（セル・文章・外の観測）。それ以外は basou が測った値。",
    notMeasured: "測れなかったもの",
    measuredWith: "測った basou {basou}{build}。",
  },
  unavailable: {
    noBoard:
      "盤のページは workspace の board/board.yaml の隣の記録を描く。board/board.yaml を読むのは、manifest がこの workspace の repo（path: .）を private と宣言しているときだけ。",
    noRecords:
      "盤の記録はまだない。board/board.yaml に盤を宣言し、basou board record で記録を書くと、ここに描かれる。",
    recordsNotDirectory:
      "board/board.yaml の隣の records/ がディレクトリでない（symlink かファイル）。",
    recordsUnreadable: "board/board.yaml の隣の records/ を読めない。",
    notFound: "記録 {record} はない。",
    notJson: "記録 {record} を JSON として読めない。",
    unknownVersion: "記録 {record} は record_version {version} で、この basou はこの版を描けない。",
    notARecord: "記録 {record} は記録の形をしていない。",
  },
  live: {
    measureNow: "いま測る",
    toRecords: "記録の盤へ",
    measuring: "workspace を測っています...",
    remeasure: "測り直す",
    measuredAt: "{at} にその場で測った（記録ではない）",
    repos: "repo",
    repo: "repo",
    branch: "branch",
    head: "HEAD",
    lastCommit: "最終 commit",
    commits: "commit 数",
    uncommitted: "未 commit",
    behindMain: "origin/main からの遅れ",
    trail: "証跡",
    decisions: "判断",
    decisionsAll: "取り消したものを含めて {n}",
    reviewGaps: "レビューの抜け",
    newestSession: "最新の session",
    noSession: "session なし",
    unimported: "未取り込み: 新規 {new}・更新 {updated}・確かめられない {unverifiable}",
    unimportedNotMeasured: "未取り込み: 測れなかった",
    byStatus: "basou verify の状態ごとの session: {list}",
    byVerdict: "basou review-gaps の判定ごとの作業の単位: {list}",
    tracks: "未完トラック",
    noTracks: "未完トラックはない。",
    components: "構成要素",
    noComponents: "見つかった構成要素はない。",
    note: "ページを開いたときに、basou がこの workspace の repo と証跡を測った値。記録には残らず、判定も含まない。",
    judged:
      "到達マトリクス・レーン・operator の手番は、判定の記録から描かれる。board/board.yaml に盤を宣言し、AI に判定させて basou board record で記録すると、ここに出る。",
  },
};

/** The fixed strings of the board page for a resolved view language. */
export function boardPageStrings(language: ViewLanguage): BoardPageStrings {
  return language === "ja" ? BOARD_PAGE_JA : BOARD_PAGE_EN;
}

/**
 * The words `basou board init` writes into a board.yaml it prints, in the
 * anchor's language: the board's title, what each stage means by default,
 * the sample lane a board starts with and the comments that say what to
 * change. They are the user's data once printed: a board may change them all.
 */
export type BoardInitStrings = {
  /** `{name}` is the workspace's name in the manifest. */
  title: string;
  stages: Record<"01" | "02" | "03" | "04" | "05" | "06", string>;
  lane: { name: string; about: string; note: string };
  comments: {
    head: string;
    stages: string;
    lanes: string;
    observe: string;
    components: string;
    axis: string;
    effort: string;
    /** The start is today in UTC: this host's zone has no name. */
    effortToday: string;
    timeZone: string;
  };
};

const BOARD_INIT_EN: BoardInitStrings = {
  title: "{name} progress board",
  stages: {
    "01": "Concept — a document says what the lane is for",
    "02": "Spec — what to build and how is decided",
    "03": "Built — working code is in a repo and its tests pass",
    "04": "Merged — it is on main",
    "05": "Open — its users can get it",
    "06": "Live — it is in use",
  },
  lane: {
    name: "A lane: who uses what",
    about: "Replace this lane with the board's own, cut by who uses what, not by repo",
    note: "What to mind when judging this lane",
  },
  comments: {
    head: "A progress board, printed by `basou board init`. Change it to fit this workspace, then check it with `basou board measure`; `basou board guide` prints the steps that judge and record it.",
    stages:
      "The six stages are fixed; only what each means is the board's. Keep 04 (merged) apart from 05 (in users' hands). `look` and `notes` say what to look at and mind when judging a stage.",
    lanes: "At least one lane. Its id is lowercase ASCII and stays: records join on it.",
    observe:
      "What to observe outside basou (npm_version, github_release, github_open_issues, github_open_prs, github_ci, page_version, manual). basou never makes these; the guide says how.",
    components:
      "Left empty: the first measure names every component it finds, and the axis review registers each with its lanes or '-' and a note.",
    axis: "Raise version when a lane is added or removed or a stage's meaning changes.",
    effort: "start is the day of the first session (today when there is none).",
    effortToday:
      "start is today in UTC: this host's time zone has no name, so the day of the first session is not known. Set start to the day the work began.",
    timeZone:
      "This host's time zone has no name a board can declare: write effort.time_zone (such as Asia/Tokyo), or the days are counted in an unnamed zone or not at all.",
  },
};

const BOARD_INIT_JA: BoardInitStrings = {
  title: "{name} 進捗盤",
  stages: {
    "01": "構想 — そのレーンが何をするものかを書いた文書がある",
    "02": "仕様 — 何をどう作るかが決まっている",
    "03": "実装 — 動くコードが repo にあり、テストが通る",
    "04": "本番 — main に入っている",
    "05": "開通 — 利用者が手に取れる",
    "06": "稼働 — 実際に使われている",
  },
  lane: {
    name: "レーンの名前（誰が使う何か）",
    about: "このレーンを、この盤のレーンに切り直す。repo ではなく「誰が使う何か」で切る",
    note: "このレーンを判定するときの注意",
  },
  comments: {
    head: "進捗盤の宣言（basou board init が出した雛形）。この workspace に合わせて直し、basou board measure で確かめる。判定と記録の手順は basou board guide が出す。",
    stages:
      "6 段の id は固定で、盤が決めるのは意味だけ。04 本番（main に入った）と 05 開通（利用者が手に取れる）を分ける。look と notes は、その段を判定するときに見るものと注意。",
    lanes: "レーンは 1 本以上。id は小文字の ASCII で、記録の照合に使うので変えない。",
    observe:
      "basou の外で観測するもの（npm_version・github_release・github_open_issues・github_open_prs・github_ci・page_version・manual）。basou は取りに行かない。取り方は guide が出す。",
    components:
      "空のままでよい。最初の measure が見つけた構成要素を全部名指しし、軸の見直しで各要素をレーンに（数えないなら '-' と note で）登録する。",
    axis: "レーンの増減や段の意味を変えたら version を上げる。",
    effort: "start は最初の session の日（session が無ければ今日）。",
    effortToday:
      "start は UTC の今日。このホストの time zone に名前が無く、最初の session の日が分からないため。仕事を始めた日に直す。",
    timeZone:
      "このホストの time zone に、盤に書ける名前が無い。effort.time_zone（例 Asia/Tokyo）を書かないと、期間と労力は名前の無い zone で数えられるか、測られない。",
  },
};

/** The words `basou board init` writes, for a resolved view language. */
export function boardInitStrings(language: ViewLanguage): BoardInitStrings {
  return language === "ja" ? BOARD_INIT_JA : BOARD_INIT_EN;
}
