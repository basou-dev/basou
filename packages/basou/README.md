# basou

A convenience installer that exposes the same `basou` binary as the
[@basou/cli](https://www.npmjs.com/package/@basou/cli) package.

**Note:** the unscoped `basou` package is not published to npm yet — the
scoped packages are. Install the CLI directly for now:

```bash
npm install -g @basou/cli
```

Once the unscoped package is published, `npm install -g basou` will expose
the identical `basou` binary on your `PATH`. This package contains no code of
its own — it depends on `@basou/cli` at the matching version and re-exports
its binary through a thin shim, so the behaviour is identical regardless of
which install command you run.

## Why does this package exist?

Basou is published under the `@basou` npm scope (`@basou/core`,
`@basou/cli`, `@basou/sdk`). The unscoped `basou` name is reserved for
users who discover the project by its plain name and do not yet know
about npm scopes.

## What does it install?

Exactly one binary: `basou`. Run `basou --help` to see the
available commands. The behaviour is identical to running
`@basou/cli` directly.

## Versioning

This package's version tracks the matching `@basou/cli` release: a
given `basou@X.Y.Z` always installs `@basou/cli@X.Y.Z` underneath. Use
whichever install path you prefer; do not mix.

## License

Apache 2.0 — same terms as the underlying `@basou/cli` package.
See [LICENSE](LICENSE).

## Source

The source for this package and the rest of Basou lives at
[github.com/basou-dev/basou](https://github.com/basou-dev/basou).
