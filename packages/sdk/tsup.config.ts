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
 * The SDK is stamped for the same reason core is, and it matters more here:
 * the SDK is a semver-GUARANTEED surface, and an embedding consumer has no
 * `basou --version` to fall back on. Without a stamp they would have strictly
 * less ability to identify what they are running than a CLI user has.
 *
 * A value baked in at build time cannot drift: it is whatever was true when
 * these bytes were produced. The commit is what actually distinguishes two
 * builds of the same version number, which is the case that went unnoticed.
 *
 * The date is the COMMIT's date, never `Date.now()`. A wall clock would make
 * every build of one commit emit different bytes, and the release pipeline
 * builds twice -- once to publish to npm with provenance, once to sign with
 * cosign -- so the signed tarball and the published one would describe the
 * same version with different contents. A consumer diffing the two would read
 * that as tampering. The commit's date is deterministic AND says more: it
 * dates the code rather than the machine that happened to compile it.
 *
 * `-dirty` is appended when the tree carries uncommitted changes, because the
 * whole point is to be honest about what is running: the project's own
 * documented source install is `pnpm -r build` from a working tree, which
 * during development is dirty nearly always, and a bare commit there names
 * code that is not what was built.
 */
function buildStamp(): string {
  const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  const git = (args: string): string =>
    execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

  let commit = "unknown";
  let committedAt = "unknown";
  try {
    const head = git("rev-parse --short HEAD");
    // `--untracked-files=no` on purpose, matching `git describe --dirty`:
    // git's own notion of a dirty build ignores untracked files, and so must
    // this. A stray file in the working directory does not change what was
    // compiled, and counting it would stamp `-dirty` on every CI artifact --
    // which it did, until a clean `actions/checkout` produced `-dirty` and
    // made the marker meaningless exactly where it is published.
    const dirty = git("status --porcelain --untracked-files=no") !== "";
    commit = dirty ? `${head}-dirty` : head;
    committedAt = git("log -1 --format=%cI");
  } catch {
    // Not a git checkout (a consumer building from a tarball): the version
    // still identifies the release; the commit is simply unavailable, and
    // saying "unknown" is the honest answer rather than a plausible-looking
    // one.
  }
  return JSON.stringify({ version: pkg.version, commit, committedAt });
}

export default defineConfig({
  define: { __BASOU_BUILD_STAMP__: JSON.stringify(buildStamp()) },
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
});
