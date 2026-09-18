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
 * The SDK's own build identity.
 *
 * The SDK is a semver-guaranteed surface, and a consumer embedding it has no
 * `basou --version` to fall back on: this is the only way for them to say
 * which build they are running. It is stamped separately from `@basou/core`
 * for the same reason the CLI is -- they are distinct artifacts, and a partial
 * build can leave them at different commits.
 */
export const BASOU_SDK_BUILD: BuildStamp | undefined = (() => {
  if (typeof __BASOU_BUILD_STAMP__ !== "string") return undefined;
  try {
    return JSON.parse(__BASOU_BUILD_STAMP__) as BuildStamp;
  } catch {
    return undefined;
  }
})();
