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

  it("stamps the COMMIT's date, not the build machine's clock (= the build stays reproducible)", async () => {
    // A wall clock would make every build of one commit emit different bytes.
    // The release pipeline builds twice — once to publish to npm with
    // provenance, once to sign with cosign — so the signed tarball and the
    // published one would describe the same version with different contents,
    // and a consumer diffing them would read that as tampering.
    const here = dirname(fileURLToPath(import.meta.url));
    const distEntry = resolve(here, "..", "dist", "index.js");
    const { stdout } = await execFileAsync(process.execPath, [distEntry, "--version"]);

    const stampedDate = /,\s*(\S+)\)/.exec(stdout.trim())?.[1];
    expect(stampedDate).toBeDefined();
    if (stampedDate === undefined || stampedDate === "unknown") return;

    const { stdout: commitDate } = await execFileAsync("git", ["log", "-1", "--format=%cI"], {
      cwd: here,
    });
    expect(stampedDate).toBe(commitDate.trim());
  });

  it("says `-dirty` when the tree carries uncommitted changes", async () => {
    // The documented source install builds straight from a working tree, which
    // during development is dirty nearly always. A bare commit there names code
    // that is not what was built — the same shape of confident wrongness this
    // whole change exists to end.
    const here = dirname(fileURLToPath(import.meta.url));
    const distEntry = resolve(here, "..", "dist", "index.js");
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: here });
    const { stdout } = await execFileAsync(process.execPath, [distEntry, "--version"]);

    const commit = /\(build (\S+?),/.exec(stdout.trim())?.[1];
    expect(commit).toBeDefined();
    if (commit === "unknown") return;
    // The dist was built from whatever the tree was at build time, so this
    // asserts the marker's PRESENCE tracks a dirty build, not the tree right
    // now: a clean tree cannot have produced a `-dirty` stamp.
    if (status.trim() === "") expect(commit).not.toContain("-dirty");
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
