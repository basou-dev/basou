# Generated Markdown: handoff.md and decisions.md

This document specifies the two human-facing Markdown artifacts basou
generates from events.jsonl.

## §10.1 Shared policy

- **Generated**: basou produces them by reading events.jsonl.
- **Manually appendable**: humans may add supplementary notes.
- **Regeneration behavior**: the generated region is refreshed; manually
  appended content is preserved.
- **Commit recommendation**: yes, these are intended for commit.

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

**In v0.1, only entries that originate from `decision_recorded` events make
it into decisions.md.**

- basou does not infer "decisions" from raw AI output or git diffs.
- Only entries the user explicitly records via `basou decision record` (or
  equivalent) are considered. The events.jsonl history remains the source
  of truth; `decisions.md` is a UX-only projection of the rich fields
  attached to each `decision_recorded` event.
- AI-assisted decision extraction is reconsidered for v0.2 or later.

This follows basou's principle that an evidence trail must carry human
intent.
