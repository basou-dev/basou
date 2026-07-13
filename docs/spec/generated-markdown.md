# Generated Markdown: handoff.md, decisions.md, report, and orientation

This document specifies the human-facing Markdown artifacts basou generates by
reading provenance. They fall into two categories:

- **Living generated artifacts** — `handoff.md` and `decisions.md`. basou owns a
  marker-delimited region inside a file that is committed and re-generated in
  place; human-authored notes outside the markers are preserved.
- **Snapshot export** — `basou report generate`. A point-in-time document with
  **no markers**: it is printed to stdout (or written to a `--out` path) as a
  whole, and is never partially re-generated. See §10.6.
- **Transient current-position view** — `.basou/orientation.md`, written by
  `basou orient`. A markerless, **gitignored** snapshot of the workspace's
  current position; the whole file is overwritten on every run (no hand-edited
  region to preserve) and it is also printed to stdout. See §10.7.

All four share the same surface convention: an English document title, a
`> Generated at <iso>` line, and localized `##` section headings (see the view
language rule below).

## §10.0 Generated-content language ("the workspace speaks the anchor's language")

The tool-generated chrome of all four views — section headings, labels, and
verdict prose — is localized per workspace, resolved from the manifest roster:

- The view language follows the **anchor repo** — the `repos[]` entry whose
  `path` is `.` (the planning/trail home the views live in). This is a
  deliberate, documented coupling between the anchor's declared audience and
  the views' audience; other repos' languages do not participate.
- `language: ja` on the anchor renders Japanese chrome; `en` renders English.
- `en+ja` resolves to **English**: a generated view has exactly one chrome
  language, and English is the shared floor of a bilingual audience.
- When no roster, no anchor entry, or no `language` is declared — or the
  manifest is missing or unreadable — the fallback is **English**, silently:
  rendering never fails or warns over language resolution.

Only the tool-generated strings are localized. User data — decision titles,
notes, session labels, file paths — always passes through verbatim, whatever
language it is written in. There is no environment-variable or CLI-flag
override: `handoff.md` / `decisions.md` are committed team artifacts, so their
language is a project declaration (the manifest), not a caller preference.

The rendered prose itself (headings, wording) is presentation, not contract —
see `compatibility.md`. The templates below show the English chrome.

### Instruction files (preset block, view block, anchor starter)

The same declaration-driven rule extends to the GENERATED INSTRUCTION FILES
(`basou project preset` / `derive` / `retrofit` / anchor seeding), with one
refinement: a repo's preset block lives inside that repo's own instruction
file, so its content language follows the **repo's own** declared `language`
(`ja` renders Japanese; `en`, `en+ja`, or an undeclared language render
English — silently, like the views). Workspace-level instruction artifacts —
the view's generated AGENTS.md block and the anchor's create-only starter —
follow the **anchor entry's** language, mirroring the views' rule.

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

- Last session: ses_01HX...C (completed)
- Last task: task_01HX_lp_form (in_progress)

## Recently changed files

- src/components/ContactForm.tsx
- src/styles/contact.css

## Latest decision

- Adopted zod for ContactForm validation [decision_01HX...]

## Unresolved items

- 1 pending approvals

## Files to read next

- .basou/decisions.md
- src/components/ContactForm.tsx

## Work to do next

- Finalize the post-submission UI flow (planned) [task_01HX...]

## Sessions

| short_id | status | started_at | label |
|---|---|---|---|
| 01HX...C | completed | 2026-05-04T12:00:00+09:00 | lp form |
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

- date: 2026-05-04
- session: 01HX...
- decision: adopt zod
- rationale: integrates with the TypeScript type system; error messages
  are easy to customize
- alternatives: yup, joi, hand-written validation
- rejected_reason: yup's TypeScript integration is weak; joi is
  overkill; hand-written is maintenance-heavy
- linked_events: evt_01HX..., evt_01HX...
- linked_files: src/components/ContactForm.tsx
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

**Sections** (in order): `## Summary`, `## Work volume` (volume + time),
`## Decisions`, `## Approvals`, `## Tasks`, `## Changed files`, `## Sessions`,
`## Integrity` (localized per §10.0). The markdown caps long lists with a `... +N more` line; the `--json`
shape always carries the full set. Changed files union only **non-import** sessions
(matching handoff), so cross-workspace round-trip imports do not dominate.

```markdown
# Report — Client X

> Generated at 2026-05-09T03:00:00.000Z (2026-05-04..2026-05-08)

## Summary

- Sessions: 12 (completed 9, failed 1, imported 2)
- Active time 6h 12m, 412,300 output tokens

## Work volume

- Output tokens: 412,300
- Actions: 84 commands, 37 files, 9 decisions
- Active time: 6h 12m  (union; idle gaps > 5m excluded; tz UTC)
- Span: 31h 40m  (total elapsed)

## Integrity

Provenance internally tamper-checked: 10 verified, 2 unchained, 0 empty, 0 incomplete, 0 in_progress, 0 tampered (of 12 sessions).

This reflects internal consistency of the local event-log hash chain — not a third-party cryptographic proof.
```

## §10.7 orientation (transient current-position view)

`basou orient` produces `.basou/orientation.md`: a point-in-time **current
position** view for a supervisor who has delegated execution to AI agents and
needs to re-orient — *where am I now, what is in flight, where am I heading, is
this current*. It composes the existing read primitives only and adds no new
persisted schema.

**Transient, not living.** Unlike `handoff.md` / `decisions.md` it carries **no
markers** and is **gitignored**: the whole file is overwritten on every run
(there is no hand-edited region to preserve), so it is a re-derivable cache of
the current position rather than a committed artifact. `basou orient` also prints
the body to stdout (the primary surface); `--quiet` writes the file only.

**Runs no import.** `basou orient` reflects already-captured state and never
triggers an import, so the freshness section is an honest staleness signal rather
than an always-"just now" no-op (run `basou refresh` to re-import — which also
regenerates `orientation.md`).

**Structured facts over prose.** The value is the structured state an LLM cannot
reliably derive from raw transcripts: the pending-approval list (risk / action /
reason, not just a count), suspect sessions, in-flight task linkage, and capture
freshness / coverage.

**Positioning.** It shows product state, blockers, freshness, confidence, and
next intent only. It MUST NOT show per-agent scorecards, productivity
comparisons, or utilization — orientation is self-orientation about your own
product, not surveillance of the fleet.

**Sections** (in order): `## Where you are now`, `## Recent direction (last N
sessions)`, `## What is in flight` (structured facts), `## Where you are
heading`, `## Is this current` (capture freshness / coverage) — localized per
§10.0.
