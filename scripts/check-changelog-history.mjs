#!/usr/bin/env node
// Refuse a change that edits CHANGELOG notes for a version that already shipped.
//
// The incident this exists for: two PRs each appended to `## Unreleased` at the
// same position. GitHub did not call it a conflict -- both stayed CLEAN and both
// merged -- but after the second squash one entry had landed inside the shipped
// `## 0.43.0` section. 0.43.0 was already on npm and basou.dev, so the release
// notes of a published version would have described a change it did not contain.
// It was caught only because someone counted the Unreleased entries before the
// bump. Counting is a human step, and this failure mode is silent, so the count
// belongs in CI.
//
// The rule: everything from the FIRST released-version heading down is history.
// The boundary is read from the BASE revision, so the release commit -- which
// renames `## Unreleased` to `## <version> — <date>`, a line above that heading
// -- is unaffected. Appending to Unreleased is likewise above it and allowed.
//
// There is deliberately no escape hatch. A genuine correction to shipped notes
// is rare enough to be worth a conversation, and an opt-out that an automated
// squash could set would reopen exactly the hole this closes.

import { execFileSync } from "node:child_process";

const CHANGELOG = "CHANGELOG.md";
const RELEASED_HEADING = /^## \d+\.\d+\.\d+/;

/** `git` with arguments, as text; throws with the command on failure. */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/**
 * 1-based line of the first released-version heading, or null when the file has
 * none (nothing has shipped yet, so nothing is history).
 */
function firstReleasedHeadingLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (RELEASED_HEADING.test(lines[i] ?? "")) return i + 1;
  }
  return null;
}

/**
 * Base-side line ranges a diff touches, from `-U0` hunk headers.
 *
 * `@@ -a,b +c,d @@` removes/replaces base lines a..a+b-1. When `b` is 0 the hunk
 * is a pure insertion AFTER base line `a`, which touches no existing line -- so
 * it is reported as the single position `a`, and the caller compares it against
 * the heading with that meaning in mind.
 */
function touchedBaseRanges(diff) {
  const ranges = [];
  for (const line of diff.split(/\r?\n/)) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (m === null) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push({ start, count, insertion: count === 0 });
  }
  return ranges;
}

function main() {
  const base = process.argv[2] ?? process.env.BASE_REF ?? "origin/main";

  let baseText;
  try {
    baseText = git(["show", `${base}:${CHANGELOG}`]);
  } catch {
    console.log(`No ${CHANGELOG} at ${base}; nothing to guard.`);
    return 0;
  }

  const boundary = firstReleasedHeadingLine(baseText);
  if (boundary === null) {
    console.log(`No released-version heading in ${CHANGELOG} at ${base}; nothing is history yet.`);
    return 0;
  }

  const diff = git(["diff", "-U0", `${base}...HEAD`, "--", CHANGELOG]);
  if (diff.trim().length === 0) {
    console.log(`${CHANGELOG} is unchanged.`);
    return 0;
  }

  const offenders = [];
  for (const r of touchedBaseRanges(diff)) {
    // A pure insertion after base line `a` lands inside history only when `a` is
    // the heading itself or below it. Inserting after line `boundary - 1` is the
    // tail of the Unreleased section, which is the normal case.
    const hitsHistory = r.insertion ? r.start >= boundary : r.start + r.count - 1 >= boundary;
    if (hitsHistory) offenders.push(r);
  }

  const headingText = baseText.split(/\r?\n/)[boundary - 1] ?? "";
  if (offenders.length > 0) {
    console.error(`::error::${CHANGELOG} edits notes for a version that already shipped`);
    console.error(`History starts at ${base}:${CHANGELOG}:${boundary} — "${headingText}".`);
    console.error("Hunks reaching into it (base-side line numbers):");
    for (const r of offenders) {
      console.error(
        r.insertion
          ? `  insertion after line ${r.start}`
          : `  lines ${r.start}-${r.start + r.count - 1}`,
      );
    }
    console.error(
      "New entries belong under `## Unreleased`. If an entry landed here because a" +
        " squash moved it, move it back rather than releasing notes that describe a" +
        " change the published version does not contain.",
    );
    return 1;
  }

  console.log(
    `${CHANGELOG} touches only the Unreleased region (history starts at line ${boundary}).`,
  );
  return 0;
}

process.exit(main());
