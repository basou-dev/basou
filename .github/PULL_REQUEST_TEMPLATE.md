<!--
PR title: one declarative sentence (e.g. "Fix Lock-is-held message
wording"). See CONTRIBUTING.md → "Commits and pull requests".
-->

## Summary

<!-- 1-2 sentences describing what changes. -->

## Why

<!--
Motivation. What friction this removes, what user-visible behaviour
shifts (or stays). For pure refactors, what made the previous shape
hard to extend / read.
-->

## Checklist

- [ ] Branch is rebased on `main`.
- [ ] One commit per topic (split unrelated fixes into separate PRs).
- [ ] Tests cover the change (happy path + at least one failure mode
      for new behaviour; a regression test for bug fixes).
- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm test` are all green
      locally.
- [ ] `CHANGELOG.md` `## Unreleased` updated (or this PR is pure
      internals with no user-visible change — say so below).
- [ ] CLI stderr stays pathless (no absolute paths or cwd in new
      error messages; native fs/spawn `error.cause.message` is not
      surfaced).

## Related

<!-- Issue numbers, prior PRs, design notes — optional. -->
