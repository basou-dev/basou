#!/usr/bin/env node
// Language lint: enforce the project convention that basou's public surface
// (source, comments, errors, CLI output) is English only.
//
// It scans packages/*/src/**/*.ts (excluding *.test.ts) for Japanese characters
// — kana (U+3040–U+30FF), CJK ideographs (U+4E00–U+9FFF), and full-width forms
// (U+FF00–U+FFEF) — and fails if any appears in a file that is NOT on the
// allowlist below.
//
// Biome does not detect natural-language content, so this is a separate check
// (`pnpm lint:lang`) that runs alongside the biome lint.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Files where Japanese is permitted under the E-5 exception (user-facing output
// whose language is intentionally Japanese, or content whose language is tied to
// a declared surface). Each entry is repo-root-relative and documents WHY it is
// allowed. Keep this list small — a new entry needs an explicit E-5 rationale,
// not a convenience escape from translating output.
const ALLOWLIST = [
  // E-5: orientation.md render output — a user-facing status surface (Japanese).
  "packages/core/src/orientation/orientation-renderer.ts",
  // E-5: handoff.md render output — a user-facing status surface (Japanese).
  "packages/core/src/handoff/handoff-renderer.ts",
  // E-5: decisions.md render output — a user-facing status surface (Japanese).
  "packages/core/src/decisions/decisions-renderer.ts",
  // E-5: status report render output — a user-facing status surface (Japanese).
  "packages/core/src/report/report-renderer.ts",
  // E-5: generated instruction-file preset — the content language is tied to the
  // declared `language` of the target repo, a separate surface from CLI output.
  "packages/core/src/project/preset.ts",
];

// CJK symbols & punctuation (U+3000-303F, e.g. 、。「」), Hiragana/Katakana
// (U+3040-30FF), CJK Unified Ideographs (U+4E00-9FFF), and full-width /
// half-width forms (U+FF00-FFEF).
const JAPANESE = /[　-ヿ一-鿿＀-￯]/;

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

const allowed = new Set(ALLOWLIST);
const violations = [];
for (const file of targets) {
  const rel = relative(REPO_ROOT, file);
  if (allowed.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (JAPANESE.test(line)) {
      violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    `Language lint: found Japanese in ${violations.length} line(s) outside the allowlist (basou's public surface is English only):`,
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`Language lint: OK (${targets.length} source files scanned, no disallowed Japanese).`);
