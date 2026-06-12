# Generated Markdown: handoff.md, decisions.md, and report

This document specifies the human-facing Markdown artifacts basou generates by
reading provenance. They fall into two categories:

- **Living generated artifacts** — `handoff.md` and `decisions.md`. basou owns a
  marker-delimited region inside a file that is committed and re-generated in
  place; human-authored notes outside the markers are preserved.
- **Snapshot export** — `basou report generate`. A point-in-time document with
  **no markers**: it is printed to stdout (or written to a `--out` path) as a
  whole, and is never partially re-generated. See §10.6.

All three share the same surface convention: an English document title, a
`> Generated at <iso>` line, and Japanese `##` section headings with
mostly-English inline content.

## §10.1 Living-artifact policy (handoff.md, decisions.md)

- **Generated**: basou produces them by reading events.jsonl.
- **Manually appendable**: humans may add supplementary notes.
- **Regeneration behavior**: the generated region is refreshed; manually
  appended content is preserved.
- **Commit recommendation**: yes, these are intended for commit.

This marker policy does **not** apply to `basou report generate`, which is a
markerless snapshot (§10.6).

## §10.2 Marker convention

basou recognizes a generated region only when the boundary markers appear
on their own lines:

```markdown
<!-- BASOU:GENERATED:START -->
(generated region; replaced on regeneration)
<!-- BASOU:GENERATED:END -->

(content outside the markers is human-authored; preserved across regenerations)
```

Strict line-level matching of the markers is mandated by the spec: the
markers are only recognized at the start of a line, and trailing annotation
text on the marker line is accepted to support legacy variants.

## §10.3 handoff.md template

```markdown
<!-- BASOU:GENERATED:START -->
# Handoff

> Generated at 2026-05-04T15:30:00+09:00 from ses_01HX...A..ses_01HX...C

## Current state

- Latest session: ses_01HX...C (completed)
- Latest task: task_01HX_lp_form (in_progress)

## Recently changed files

- src/components/ContactForm.tsx
- src/styles/contact.css

## Recent decisions

- Adopted zod for ContactForm validation (decision_01HX...)

## Open questions

- Redirect destination after submission success

## Files to read next

- src/components/ContactForm.tsx
- .basou/decisions.md

## Next steps

- Finalize the post-submission UI flow
- Add an E2E test
<!-- BASOU:GENERATED:END -->

<!-- Below: human-authored notes -->

## Notes

Meeting with the client tomorrow morning about the redirect destination.
```

## §10.4 decisions.md template

`decisions.md` carries rich fields per decision: `rationale`,
`alternatives`, `rejected_reason`, `linked_events`, and `linked_files`.
These fields originate from `decision_recorded` events.

```markdown
<!-- BASOU:GENERATED:START -->
# Decisions

> Generated at 2026-05-04T15:30:00+09:00

## decision_01HX...: ContactForm validation

- **Date**: 2026-05-04
- **session**: ses_01HX...
- **Decision**: adopt zod
- **rationale**: integrates with the TypeScript type system; error messages
  are easy to customize
- **alternatives**: yup, joi, hand-written validation
- **rejected_reason**: yup's TypeScript integration is weak; joi is
  overkill; hand-written is maintenance-heavy
- **linked_events**: evt_01HX..., evt_01HX...
- **linked_files**: src/components/ContactForm.tsx
<!-- BASOU:GENERATED:END -->

<!-- Below: human-authored notes -->
```

## §10.5 decisions.md generation principle

**Only entries that originate from `decision_recorded` events make
it into decisions.md.**

- basou does not infer "decisions" from raw AI output or git diffs.
- Only entries the user explicitly records via `basou decision record` (or
  equivalent) are considered. The events.jsonl history remains the source
  of truth; `decisions.md` is a UX-only projection of the rich fields
  attached to each `decision_recorded` event.
- AI-assisted decision extraction is reconsidered for a future release.

This follows basou's principle that an evidence trail must carry human
intent.

## §10.6 report (snapshot export)

`basou report generate` produces a neutral, point-in-time **work report**: a
human-readable explanation of the work captured in a workspace — how much, what
was decided / approved / undertaken, which files changed, and whether the local
provenance is internally consistent. It is a *snapshot export*, not a living
artifact: markerless, never partially re-generated. It is the external-explanation
sibling of `handoff.md` (which hands work *forward*) and of `basou stats` (raw
internal analytics).

**Positioning.** The report is a "explain your own work" export you may choose to
share — deliberately NOT an audit, billing, or compliance product. Its language
stays neutral: the word "billable" never appears, and the integrity section
states internal hash-chain consistency only, never a third-party cryptographic
proof.

**Output.** stdout by default; `--out <path>` writes the markdown to a file (with
a one-line confirmation on stderr); `--json` emits a curated structured shape on
stdout (JSON-only, pipe-safe). `--title <text>` adds a subject line. A successful
render always exits 0 — integrity verdicts inside the report are informational and
never fail the command (unlike `basou verify`).

**Sections** (in order): `## 概要` (summary), `## 作業量` (volume + time),
`## 判断` (decisions), `## 承認` (approvals), `## タスク` (tasks),
`## 変更ファイル` (changed files), `## セッション一覧` (sessions), `## 整合性`
(integrity). The markdown caps long lists with a `... +N more` line; the `--json`
shape always carries the full set. Changed files union only **non-import** sessions
(matching handoff), so cross-workspace round-trip imports do not dominate.

```markdown
# Report — Client X

> Generated at 2026-05-09T03:00:00.000Z (2026-05-04..2026-05-08)

## 概要

- Sessions: 12 (completed 9, failed 1, imported 2)
- Active time 6h 12m, 412,300 output tokens

## 作業量

- Output tokens: 412,300
- Actions: 84 commands, 37 files, 9 decisions
- Active time: 6h 12m  (union; idle gaps > 5m excluded; tz UTC)
- Span: 31h 40m  (total elapsed)

## 整合性

Provenance internally tamper-checked: 10 verified, 2 unchained, 0 empty, 0 incomplete, 0 in_progress, 0 tampered (of 12 sessions).

This reflects internal consistency of the local event-log hash chain — not a third-party cryptographic proof.
```
