---
name: Bug report
about: Report a CLI error, surprising output, or test failure
title: "[bug] "
labels: ["bug"]
assignees: []
---

## What happened?

<!--
One paragraph: what you expected vs. what you saw. If the CLI exited
non-zero, include the exit code. If the CLI exited zero but printed
something surprising, say so explicitly.
-->

## Steps to reproduce

<!--
Number each step. Start from a fresh state where possible
(`git clone`, `pnpm install`, `pnpm -r build`, then the commands you
ran). If the bug only reproduces against a specific repo or workspace
shape, describe that shape — do not paste private paths.
-->

1.
2.
3.

## Output / error message

<!--
Paste the verbatim CLI output. Basou's stderr is supposed to be
pathless (no absolute paths or cwd), so if you see an absolute path
in the error, that itself is part of the bug — include it as-is.
For long output, fence it in a triple-backtick block.
-->

```
```

## Environment

- `basou --version`:
- Node.js version (`node --version`):
- pnpm version (`pnpm --version`):
- OS (macOS / Linux + version):

## Workspace short_id (optional)

<!--
If the bug touches a specific workspace, paste the Workspace ID from
`basou status` (it looks like `01HX...`). Skip if N/A.
-->

## Sanity check (optional)

<!--
If `pnpm test` or `basou` failed on a fresh checkout, mention which
line of the quickstart sanity-check passed last and which one failed.
Reference: https://basou.dev/quickstart/#sanity-check-checklist
-->

- Last passing line:
- First failing line:
