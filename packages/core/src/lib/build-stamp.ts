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
  readonly builtAt: string;
};

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
export const BASOU_CORE_BUILD: BuildStamp | undefined = (() => {
  if (typeof __BASOU_BUILD_STAMP__ !== "string") return undefined;
  try {
    return JSON.parse(__BASOU_BUILD_STAMP__) as BuildStamp;
  } catch {
    return undefined;
  }
})();
