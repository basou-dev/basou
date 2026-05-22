# basou docs

This directory contains the public specification for **basou**,
prepared for OSS distribution.

## Layout

```
docs/
├── README.md                       (this file)
└── spec/
    ├── overview.md                 product foundations and scope
    ├── workspace.md                .basou/ layout, sessions, tasks, IDs
    ├── schemas.md                  manifest / session / event schemas
    ├── approval.md                 approval event semantics
    ├── generated-markdown.md       handoff.md / decisions.md rules
    ├── terminal-and-import.md      session lifecycle, terminal recording, import
    └── cli-commands.md             CLI command catalog
```

## How to use

- For installation, usage, and quick start, see the project root
  [`README.md`](../README.md).
- For the specification of basou's data model and CLI behavior, read the files
  under [`spec/`](spec/).
- This documentation tracks the v0.1 / v0.2 implementation. Sections that
  cover features deferred to v0.3 or later are explicitly marked as such.

## Versioning

These documents describe the behavior of basou as released in v0.2.x. When new
features land in a future release, the corresponding section is updated as
part of that release.
