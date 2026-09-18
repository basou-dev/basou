import { execFile, execFileSync } from "node:child_process";
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

    const line = stdout.trim();
    const stampedDate = /,\s*(\S+)\)/.exec(line)?.[1];
    const stampedCommit = /\(build (\S+?),/.exec(line)?.[1];
    expect(stampedDate).toBeDefined();
    if (stampedDate === undefined || stampedCommit === undefined || stampedCommit === "unknown") {
      return;
    }

    // Compared against the commit the stamp NAMES, not against HEAD. Asserting
    // HEAD would fail whenever the dist was not rebuilt after the last commit —
    // a true statement about staleness, but not the property under test, which
    // is that the date comes from the commit rather than from a wall clock.
    const { stdout: commitDate } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%cI", stampedCommit.replace(/-dirty$/, "")],
      { cwd: here },
    );
    expect(stampedDate).toBe(commitDate.trim());
  });

  it("marks a build `-dirty` on the same terms as `git describe --dirty`", () => {
    // Asserted against git's own answer rather than against the ambient tree,
    // because the property is "we mark dirtiness the way git defines it", not
    // "this checkout happens to be clean". The earlier version asserted the
    // latter and failed in CI on a clean `actions/checkout` -- untracked files
    // were being counted, which would have stamped `-dirty` on every published
    // artifact.
    const here = dirname(fileURLToPath(import.meta.url));
    const tracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: here,
      encoding: "utf8",
    });
    const described = execFileSync("git", ["describe", "--always", "--dirty"], {
      cwd: here,
      encoding: "utf8",
    }).trim();
    expect(described.endsWith("-dirty")).toBe(tracked.trim() !== "");
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
