import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Freeze the identity of THIS build into the bundle — see the matching helper
 * in `packages/cli/tsup.config.ts` for why a runtime read of `package.json`
 * cannot answer the question.
 *
 * Core is stamped separately because it is a separate artifact: the CLI does
 * not bundle it, so `cli/dist` and `core/dist` can be rebuilt independently.
 * A fresh CLI in front of a stale core is the dangerous half of that pair,
 * since core is where the renderers and importers live.
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
    // Not a git checkout (building from a tarball): version and build time
    // still identify the build; the commit is simply unavailable.
  }
  return JSON.stringify({ version: pkg.version, commit, builtAt: new Date().toISOString() });
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
