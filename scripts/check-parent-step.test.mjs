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
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./check-parent-step.mjs", import.meta.url));

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Run the guard over a tree holding one file; return its exit code and stderr. */
function runGuard(file, line) {
  const root = mkdtempSync(join(tmpdir(), "basou-parent-step-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(GUARD, join(root, "scripts", "check-parent-step.mjs"));
  const src = join(root, "packages", "core", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, file), `${line}\n`);
  try {
    execFileSync(process.execPath, [join(root, "scripts", "check-parent-step.mjs")], {
      stdio: "pipe",
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    return { code: error.status, stderr: String(error.stderr) };
  }
}

for (const line of [
  'const out = rel.startsWith("..");',
  "const out = rel.startsWith('..');",
  "const out = rel.startsWith(`..`);",
  'const out = rel.startsWith( ".." );',
  'const out = rel.startsWith("..", 1);',
]) {
  test(`fails on ${line}`, () => {
    const { code, stderr } = runGuard("a.ts", line);
    assert.equal(code, 1);
    assert.match(stderr, /packages\/core\/src\/a\.ts:1:/);
  });
}

for (const line of [
  'const out = rel === ".." || rel.startsWith("../");',
  "const out = rel.startsWith(`..${sep}`);",
  'const out = s.startsWith("...", at);',
  'const out = rel.startsWith("..x");',
]) {
  test(`passes ${line}`, () => {
    assert.equal(runGuard("a.ts", line).code, 0);
  });
}

test("does not scan test files", () => {
  assert.equal(runGuard("a.test.ts", 'expect(rel.startsWith("..")).toBe(false);').code, 0);
});
