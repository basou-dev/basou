#!/usr/bin/env node
// Path lint: forbid testing a `path.relative` result for a step out of its
// base with `startsWith("..")`.
//
// `relative` spells a step out as `..` or `../...`, but the prefix test also
// matches a name that merely begins with two dots (`..notes`, `..\x`, `...`),
// so an in-base path is read as outside. The same mistake once sat in five
// places and took two releases to remove. Inside @basou/core use
// `locateRelative` (packages/core/src/lib/relative-location.ts); elsewhere test
// for `rel === ".."` or a `../` prefix.
//
// It scans packages/*/src/**/*.ts (excluding *.test.ts), like
// check-language.mjs, and fails on `startsWith("..")` in any quote style,
// with or without a position argument.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// `startsWith("..")`, `startsWith('..')`, startsWith(`..`), optionally followed
// by a position argument. `startsWith("...")` and `startsWith("../")` do not
// match.
const PREFIX_TEST = /startsWith\(\s*(["'`])\.\.\1\s*[,)]/;

/** Recursively collect every `*.ts` file under `dir`, skipping `*.test.ts`. */
function collectSourceFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

const targets = [];
for (const pkg of readdirSync(join(REPO_ROOT, "packages"))) {
  const srcDir = join(REPO_ROOT, "packages", pkg, "src");
  try {
    if (statSync(srcDir).isDirectory()) collectSourceFiles(srcDir, targets);
  } catch {
    // package without a src/ directory — nothing to scan
  }
}

const violations = [];
for (const file of targets) {
  const rel = relative(REPO_ROOT, file);
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (PREFIX_TEST.test(line)) {
      violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    `Path lint: found ${violations.length} \`startsWith("..")\` test(s). It also matches a name that begins with two dots (\`..notes\`); test for \`rel === ".."\` or a \`../\` prefix, or use locateRelative in @basou/core:`,
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
