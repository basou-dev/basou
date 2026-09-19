// Boundary tests for the CHANGELOG history guard.
//
// The whole artifact is a few lines of off-by-one arithmetic, and a regression
// is silent in both directions: too strict blocks every pull request loudly,
// too loose stays green forever while the thing it was built to catch walks
// through. The margin is real -- the first pull request after a release inserts
// one line above the boundary -- so the two cases either side of it are pinned
// here rather than left to a reviewer noticing.
//
// Each case builds a throwaway repo under the OS temp dir: a base CHANGELOG on
// one commit, the edit on the next, then the guard is run with the base commit
// as its argument, exactly as the workflow passes `pull_request.base.sha`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./check-changelog-history.mjs", import.meta.url));

/** A CHANGELOG whose first released heading sits on line 7. */
const BASE = [
  "# Changelog", // 1
  "", // 2
  "## Unreleased", // 3
  "", // 4
  "- an unreleased entry", // 5
  "", // 6
  "## 1.0.0 — 2026-01-01", // 7  <- boundary
  "", // 8
  "- a shipped entry", // 9
  "", // 10
  "## 0.9.0 — 2025-12-01", // 11
  "", // 12
  "- an older shipped entry", // 13
].join("\n");

const BOUNDARY = 7;
const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

/**
 * Build a repo whose base commit holds `base`, then commit `head` on top.
 * `base === null` means the file does not exist at the base commit.
 * Returns the guard's exit code and its combined output.
 */
function runGuard({ base, head }) {
  const dir = mkdtempSync(join(tmpdir(), "basou-changelog-guard-"));
  tmpDirs.push(dir);
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "t"]);

  writeFileSync(join(dir, "README.md"), "seed\n");
  if (base !== null) writeFileSync(join(dir, "CHANGELOG.md"), `${base}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]).trim();

  writeFileSync(join(dir, "CHANGELOG.md"), `${head}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "head", "--allow-empty"]);

  try {
    const stdout = execFileSync(process.execPath, [GUARD, baseSha], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** Insert `text` as a new line before 1-based `line` of BASE. */
function insertBefore(line, text) {
  const lines = BASE.split("\n");
  lines.splice(line - 1, 0, text);
  return lines.join("\n");
}

/** Replace 1-based `line` of BASE with `text`. */
function replaceLine(line, text) {
  const lines = BASE.split("\n");
  lines[line - 1] = text;
  return lines.join("\n");
}

test("an append at the tail of Unreleased passes (the one-line margin)", () => {
  const r = runGuard({ base: BASE, head: insertBefore(BOUNDARY, "- a second unreleased entry") });
  assert.equal(r.code, 0, r.out);
});

test("an insert just below the boundary fails (the incident)", () => {
  const r = runGuard({
    base: BASE,
    head: insertBefore(BOUNDARY + 1, "- an entry a squash moved into a shipped section"),
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /already shipped/);
});

test("changing the line immediately above the boundary passes", () => {
  // The tightest passing case, and the one that pins `+ r.count - 1`: the hunk
  // ends exactly at boundary - 1. Dropping the -1 makes this fail, and an
  // earlier draft replaced an already-blank line with a blank one, so git
  // produced no hunk at all and the case proved nothing.
  const r = runGuard({ base: BASE, head: replaceLine(BOUNDARY - 1, "- a trailing note") });
  assert.equal(r.code, 0, r.out);
});

test("replacing the boundary heading itself fails", () => {
  const r = runGuard({ base: BASE, head: replaceLine(BOUNDARY, "## 1.0.0 — 2026-01-02") });
  assert.equal(r.code, 1, r.out);
});

test("a hunk spanning the boundary fails", () => {
  // Both lines must differ, or git emits a hunk for the one that changed and
  // nothing spans anything -- which is how the first draft of this case passed
  // while claiming to test the opposite.
  const lines = BASE.split("\n");
  lines.splice(BOUNDARY - 2, 2, "changed above", "## 1.0.0 — 2026-01-02");
  const r = runGuard({ base: BASE, head: lines.join("\n") });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /lines 6-7/);
});

test("an edit to the OLDEST section fails too (history is everything below the first heading)", () => {
  const r = runGuard({ base: BASE, head: replaceLine(13, "- an edited older entry") });
  assert.equal(r.code, 1, r.out);
});

test("one clean hunk plus one offending hunk fails", () => {
  let head = insertBefore(BOUNDARY, "- a second unreleased entry");
  head = head.replace("- an older shipped entry", "- an older shipped entry, edited");
  const r = runGuard({ base: BASE, head });
  assert.equal(r.code, 1, r.out);
});

test("the release rename of `## Unreleased` passes -- this must never block a release", () => {
  // The release commit renames the heading and adds no `## Unreleased` back,
  // so the whole former Unreleased region becomes history on the NEXT base.
  const r = runGuard({ base: BASE, head: replaceLine(3, "## 1.1.0 — 2026-02-01") });
  assert.equal(r.code, 0, r.out);
});

test("an unchanged CHANGELOG passes", () => {
  const r = runGuard({ base: BASE, head: BASE });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unchanged/);
});

test("a base with no released heading has no history to guard", () => {
  const base = "# Changelog\n\n## Unreleased\n\n- only unreleased\n";
  const r = runGuard({ base, head: `${base}- one more\n` });
  assert.equal(r.code, 0, r.out);
});

test("a base with no CHANGELOG at all passes", () => {
  const r = runGuard({ base: null, head: BASE });
  assert.equal(r.code, 0, r.out);
});
