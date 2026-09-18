/**
 * The identity of the build that is RUNNING, frozen into the bundle by
 * `tsup.config.ts` at build time. `undefined` when this module is loaded from
 * source (tests, `tsx`), where there is no build to be stale.
 *
 * `typeof` guards an identifier esbuild only declares in a built bundle.
 */
declare const __BASOU_BUILD_STAMP__: string | undefined;

/** What a build knows about itself. `commit` is `"unknown"` outside a checkout. */
export type BuildStamp = {
  readonly version: string;
  readonly commit: string;
  readonly committedAt: string;
};

/**
 * Parse an injected stamp. Separate from the constant below so it is reachable
 * from a test: under vitest the module loads from SOURCE, where the injected
 * identifier does not exist, so every line of the parse would otherwise be
 * unreachable -- a guarantee with no test behind it, which is the shape of
 * omission this whole feature exists to correct.
 *
 * Anything unparseable yields `undefined` rather than throwing: a malformed
 * stamp must not stop the CLI from starting.
 */
export function parseBuildStamp(raw: string | undefined): BuildStamp | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<BuildStamp>;
    if (
      typeof parsed.version !== "string" ||
      typeof parsed.commit !== "string" ||
      typeof parsed.committedAt !== "string"
    ) {
      return undefined;
    }
    return { version: parsed.version, commit: parsed.commit, committedAt: parsed.committedAt };
  } catch {
    return undefined;
  }
}

/**
 * Core's own build identity.
 *
 * Core is stamped separately from the CLI because the CLI does not bundle it:
 * `cli/dist` and `core/dist` are distinct artifacts that a partial build can
 * leave at different commits. A fresh CLI in front of a stale core is the
 * dangerous half of that pair -- core is where the renderers and importers
 * live, so the behaviour would be the old one while the CLI reported the new
 * version.
 */
export const BASOU_CORE_BUILD: BuildStamp | undefined = parseBuildStamp(
  typeof __BASOU_BUILD_STAMP__ === "string" ? __BASOU_BUILD_STAMP__ : undefined,
);
