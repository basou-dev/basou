import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("@basou/cli", () => {
  it("test scaffolding works", () => {
    expect(true).toBe(true);
  });

  it("`basou --version` mirrors package.json `version` (= release drift guard)", async () => {
    // Resolve absolute paths from this test file so the assertion holds
    // regardless of the consumer's cwd. The test executes the built
    // dist/index.js (= the same artefact `pnpm --filter @basou/cli link
    // --global` exposes), so a stale bundle would surface here even when
    // the source-side BASOU_CLI_VERSION constant looks current.
    const here = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = resolve(here, "..", "package.json");
    const distEntry = resolve(here, "..", "dist", "index.js");

    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);

    const { stdout } = await execFileAsync(process.execPath, [distEntry, "--version"]);
    expect(stdout.trim()).toBe(pkg.version);
  });
});
