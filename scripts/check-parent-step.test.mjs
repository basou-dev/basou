// Tests for the path-containment guard.
//
// The tree it guards has no violations, so CI alone cannot tell a working guard
// from a broken one: a regex that stopped matching would stay green forever.
// Each case copies the guard into a throwaway tree under the OS temp dir with a
// single source file, runs it the way `pnpm lint:paths` does, and checks the
// exit code.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./check-parent-step.mjs", import.meta.url));

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the guard over a tree holding one file at `file` (repo-relative); return
 * its exit code and stderr.
 */
function runGuard(file, line) {
  const root = mkdtempSync(join(tmpdir(), "basou-parent-step-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(GUARD, join(root, "scripts", "check-parent-step.mjs"));
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), `${line}\n`);
  try {
    execFileSync(process.execPath, [join(root, "scripts", "check-parent-step.mjs")], {
      stdio: "pipe",
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    return { code: error.status, stderr: String(error.stderr) };
  }
}

// Every package, at any depth: the five sites this guard was written for sat
// in two packages and in nested directories.
const DEEP_FILES = ["packages/cli/src/commands/a.ts", "packages/core/src/lib/deep/b.ts"];

for (const [i, line] of [
  'const out = rel.startsWith("..");',
  "const out = rel.startsWith('..');",
  "const out = rel.startsWith(`..`);",
  'const out = rel.startsWith( ".." );',
  'const out = rel.startsWith("..", 1);',
].entries()) {
  const file = DEEP_FILES[i % DEEP_FILES.length];
  test(`fails on ${line} in ${file}`, () => {
    const { code, stderr } = runGuard(file, line);
    assert.equal(code, 1);
    assert.ok(stderr.includes(`${file}:1:`), stderr);
  });
}

for (const line of [
  'const out = rel === ".." || rel.startsWith("../");',
  // Built from two pieces so the template placeholder is not written out in a
  // plain string literal.
  "const out = rel.startsWith(`..$" + "{sep}`);",
  'const out = s.startsWith("...", at);',
  'const out = rel.startsWith("..x");',
]) {
  test(`passes ${line}`, () => {
    assert.equal(runGuard(DEEP_FILES[0], line).code, 0);
  });
}

test("does not scan test files", () => {
  const line = 'expect(rel.startsWith("..")).toBe(false);';
  assert.equal(runGuard("packages/core/src/lib/a.test.ts", line).code, 0);
});
