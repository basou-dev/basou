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

  it("`basou --version` reports the BUILD, and the build matches package.json", async () => {
    // This assertion used to read `stdout.trim() === pkg.version` and called
    // itself a drift guard. It could not be one: the built entry read the same
    // `package.json` at runtime, so both sides of the comparison came from one
    // file and the test passed for any dist, however old. A workspace ran a
    // build a release and a half behind for a day with this test green.
    //
    // The version now comes from a stamp frozen into the bundle at build time,
    // so the two sides have independent origins and the comparison means
    // something: bump `package.json` without rebuilding and this fails.
    const here = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = resolve(here, "..", "package.json");
    const distEntry = resolve(here, "..", "dist", "index.js");

    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);

    const { stdout } = await execFileAsync(process.execPath, [distEntry, "--version"]);
    const line = stdout.trim();

    // The version stays the FIRST token, so anything parsing the old
    // single-token output still works.
    expect(line.split(" ")[0]).toBe(pkg.version);

    // And the build identifies itself, which is what a version number alone
    // cannot do: two builds of one version differ only by commit.
    expect(line).toMatch(/\(build [0-9a-f]+|\(build unknown/);
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
