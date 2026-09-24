/**
 * Where a `path.relative(base, target)` result points, relative to `base`:
 * `"self"` for `base` itself, `"outside"` for a step out of it, `"inside"`
 * otherwise.
 *
 * `relative` spells a step out as `..` or `../...`, so only those count as
 * outside. A name that merely begins with two dots (`..notes`, `..\x`, `...`)
 * is a name inside `base`; testing for a `..` prefix alone reads it as a step
 * out. An empty result means the two paths are the same directory however
 * they were spelled, including with a trailing slash on either side. basou
 * targets macOS / Linux, where `/` is the only separator.
 *
 * Internal to `@basou/core`: shared by the path sanitizer and the source-root
 * classifier. `scripts/check-parent-step.mjs` fails CI on the prefix-only test
 * anywhere under `packages/<pkg>/src`.
 */
export function locateRelative(rel: string): "self" | "inside" | "outside" {
  if (rel === "") return "self";
  if (rel === ".." || rel.startsWith("../")) return "outside";
  return "inside";
}
