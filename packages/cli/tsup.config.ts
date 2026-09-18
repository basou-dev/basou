import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Freeze the identity of THIS build into the bundle.
 *
 * `--version` used to read `package.json` at runtime, which answers what the
 * SOURCE says rather than what the running code is. A checkout can move --
 * `git pull`, `git checkout` -- without anyone rebuilding `dist`, and the
 * answer stays confidently wrong. One workspace ran a build that was a release
 * and a half behind for a full day while `--version` reported the newest
 * release, because both readings came from the same file.
 *
 * A value baked in at build time cannot drift: it is whatever was true when
 * these bytes were produced. The commit is what actually distinguishes two
 * builds of the same version number, which is the case that went unnoticed.
 */
function buildStamp(): string {
  const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git checkout (a consumer building from a tarball): the version and
    // build time still identify the build; the commit is simply unavailable.
  }
  return JSON.stringify({ version: pkg.version, commit, builtAt: new Date().toISOString() });
}

// Two entries with different needs:
//   - index.ts   = the `basou` binary; needs the Node shebang banner.
//   - program.ts = the side-effect-free library entry (`@basou/cli/program`)
//     imported by docs tooling to introspect the command tree; must NOT
//     carry a shebang.
// tsup runs an array config in parallel (Promise.all), so neither entry may
// own `clean` — a concurrent clean would race the other's emit. `dist` is
// removed once by the package `build` script before tsup runs.
const shared = {
  define: { __BASOU_BUILD_STAMP__: JSON.stringify(buildStamp()) },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: false,
  dts: true,
  sourcemap: true,
} as const;

export default defineConfig([
  { ...shared, entry: ["src/index.ts"], banner: { js: "#!/usr/bin/env node" } },
  { ...shared, entry: ["src/program.ts"] },
]);
