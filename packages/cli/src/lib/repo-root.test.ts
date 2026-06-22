import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { basouPaths, createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBasouRootForCommand, resolveMemberToMaster } from "./repo-root.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const NOW = new Date("2026-05-10T00:00:00.000Z");

let parent: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "basou-repo-root-"));
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

/** A git repo at `<parent>/<name>`. */
async function gitRepo(name: string): Promise<string> {
  const dir = join(parent, name);
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init", dir], { env: ENV });
  return dir;
}

/** A git repo that also owns a `.basou/` store with the given source_roots. */
async function master(name: string, sourceRoots: string[]): Promise<string> {
  const dir = await gitRepo(name);
  const paths = await ensureBasouDirectory(dir);
  const base = createManifest({ workspaceName: name, now: NOW });
  await writeManifest(paths, { ...base, import: { source_roots: sourceRoots } });
  return dir;
}

/** A git repo with a `.basou/` whose manifest is present but schema-invalid. */
async function corruptMaster(name: string): Promise<string> {
  const dir = await gitRepo(name);
  const paths = await ensureBasouDirectory(dir);
  await writeFile(paths.files.manifest, "not_a: valid manifest\n", "utf8");
  return dir;
}

/** Write a portfolio registry naming `masters` (absolute paths) and return its path. */
async function portfolio(masters: { dir: string; label?: string }[]): Promise<string> {
  const lines = ["version: 1", "workspaces:"];
  for (const m of masters) {
    lines.push(`  - path: ${m.dir}`);
    if (m.label !== undefined) lines.push(`    label: ${m.label}`);
  }
  const p = join(parent, `portfolio-${masters.map((m) => m.label ?? "x").join("-")}.yaml`);
  await writeFile(p, `${lines.join("\n")}\n`, "utf8");
  return p;
}

describe("resolveMemberToMaster", () => {
  it("returns the single master that declares the repo in source_roots", async () => {
    const m = await master("planning", [".", "../blog"]);
    const member = await gitRepo("blog");
    const cfg = await portfolio([{ dir: m, label: "personal" }]);

    const found = await resolveMemberToMaster(member, cfg);
    expect(found?.root).toBe(await realpath(m));
    expect(found?.label).toBe("personal");
  });

  it("returns undefined when no master declares the repo", async () => {
    await master("planning", [".", "../blog"]);
    const unrelated = await gitRepo("unrelated");
    const cfg = await portfolio([{ dir: join(parent, "planning"), label: "personal" }]);

    expect(await resolveMemberToMaster(unrelated, cfg)).toBeUndefined();
  });

  it("a master never claims itself via its own '.' source root", async () => {
    const m = await master("planning", [".", "../blog"]);
    const cfg = await portfolio([{ dir: m, label: "personal" }]);

    expect(await resolveMemberToMaster(m, cfg)).toBeUndefined();
  });

  it("throws on ambiguity when two masters declare the same repo", async () => {
    const m1 = await master("planning-a", [".", "../blog"]);
    const m2 = await master("planning-b", [".", "../blog"]);
    await gitRepo("blog");
    const member = join(parent, "blog");
    const cfg = await portfolio([
      { dir: m1, label: "a" },
      { dir: m2, label: "b" },
    ]);

    await expect(resolveMemberToMaster(member, cfg)).rejects.toThrow(
      /declared as a source root by 2 portfolio workspaces \(a, b\)/,
    );
  });

  it("returns undefined when the portfolio registry is absent", async () => {
    const member = await gitRepo("blog");
    expect(await resolveMemberToMaster(member, join(parent, "nope.yaml"))).toBeUndefined();
  });

  it("skips a stale registry entry with no .basou store", async () => {
    // master-good claims the blog; master-bad is registered but uninitialized.
    const good = await master("good", [".", "../blog"]);
    await gitRepo("bad"); // git repo, but no .basou store
    const member = await gitRepo("blog");
    const cfg = await portfolio([
      { dir: join(parent, "bad"), label: "bad" },
      { dir: good, label: "good" },
    ]);

    const found = await resolveMemberToMaster(member, cfg);
    expect(found?.root).toBe(await realpath(good));
    expect(found?.label).toBe("good");
  });

  it("collapses the same master registered twice (a symlink alias) to a single redirect", async () => {
    const m = await master("planning", [".", "../blog"]);
    await symlink(m, join(parent, "planning-alias")); // a second spelling of the SAME master
    const member = await gitRepo("blog");
    // loadPortfolioConfig de-dupes only lexically, so both spellings survive.
    const cfg = await portfolio([
      { dir: m, label: "real" },
      { dir: join(parent, "planning-alias"), label: "alias" },
    ]);

    const found = await resolveMemberToMaster(member, cfg);
    expect(found?.root).toBe(await realpath(m)); // one claimant, not a false ambiguity
    expect(found?.label).toBe("real"); // first spelling's label wins
  });

  it("warns and returns undefined for a present-but-malformed registry", async () => {
    const member = await gitRepo("blog");
    const bad = join(parent, "bad.yaml");
    await writeFile(bad, "workspaces: not-a-list\n", "utf8");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await resolveMemberToMaster(member, bad)).toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Ignoring ~/.basou/portfolio.yaml"));
  });

  it("stays silent (no warning) when the registry is genuinely absent", async () => {
    const member = await gitRepo("blog");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await resolveMemberToMaster(member, join(parent, "nope.yaml"))).toBeUndefined();
    expect(err).not.toHaveBeenCalled();
  });

  it("warns and skips a master whose manifest is corrupt, still matching a healthy master", async () => {
    const bad = await corruptMaster("bad");
    const good = await master("good", [".", "../blog"]);
    const member = await gitRepo("blog");
    const cfg = await portfolio([
      { dir: bad, label: "bad" },
      { dir: good, label: "good" },
    ]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const found = await resolveMemberToMaster(member, cfg);
    expect(found?.root).toBe(await realpath(good));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Skipping portfolio workspace 'bad'"));
  });

  it("a master with no import.source_roots never claims a separate member", async () => {
    const m = await gitRepo("planning");
    const paths = await ensureBasouDirectory(m);
    await writeManifest(paths, createManifest({ workspaceName: "planning", now: NOW })); // no import block
    const member = await gitRepo("blog");
    const cfg = await portfolio([{ dir: m, label: "personal" }]);

    expect(await resolveMemberToMaster(member, cfg)).toBeUndefined();
  });
});

describe("resolveBasouRootForCommand (member → master)", () => {
  it("redirects a storeless portfolio member to its master", async () => {
    const m = await master("planning", [".", "../blog"]);
    const member = await gitRepo("blog");
    const cfg = await portfolio([{ dir: m, label: "personal" }]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const root = await resolveBasouRootForCommand(member, "orient", { portfolioConfigPath: cfg });
    expect(root).toBe(await realpath(m));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Resolved portfolio member to"));
  });

  it("returns a repo that owns its own store unchanged (no reverse-lookup)", async () => {
    const m = await master("planning", [".", "../blog"]);
    const cfg = await portfolio([{ dir: m, label: "personal" }]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const root = await resolveBasouRootForCommand(m, "orient", { portfolioConfigPath: cfg });
    expect(await realpath(root)).toBe(await realpath(m));
  });

  it("leaves an unclaimed storeless repo as itself (preserving the uninitialized path)", async () => {
    await master("planning", [".", "../blog"]);
    const orphan = await gitRepo("orphan");
    const cfg = await portfolio([{ dir: join(parent, "planning"), label: "personal" }]);

    const root = await resolveBasouRootForCommand(orphan, "orient", { portfolioConfigPath: cfg });
    expect(await realpath(root)).toBe(await realpath(orphan));
  });

  it("propagates a genuine ambiguity (two distinct masters) out of the command resolver", async () => {
    const m1 = await master("planning-a", [".", "../blog"]);
    const m2 = await master("planning-b", [".", "../blog"]);
    const member = await gitRepo("blog");
    const cfg = await portfolio([
      { dir: m1, label: "a" },
      { dir: m2, label: "b" },
    ]);

    await expect(
      resolveBasouRootForCommand(member, "orient", { portfolioConfigPath: cfg }),
    ).rejects.toThrow(/declared as a source root by 2 portfolio workspaces/);
  });

  it("returns a storeless member unchanged when no registry exists (preserves downstream init message)", async () => {
    const member = await gitRepo("blog");
    const root = await resolveBasouRootForCommand(member, "orient", {
      portfolioConfigPath: join(parent, "nope.yaml"),
    });
    expect(await realpath(root)).toBe(await realpath(member));
  });
});
