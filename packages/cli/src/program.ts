import { createRequire } from "node:module";
// A NAMESPACE import on purpose. This feature exists to diagnose a CLI and a
// core that were built at different commits, so it must survive one: a named
// import of a symbol an older core does not export is a module-level
// SyntaxError, and under the hook's `2>/dev/null || true` wrapper that turns
// into a silent no-op -- strictly worse than the stale build it is meant to
// reveal. Read through the namespace so a missing export is just `undefined`.
import * as basouCore from "@basou/core";
import { Command } from "commander";
import { registerApprovalCommand } from "./commands/approval.js";
import { registerChannelCommand } from "./commands/channel.js";
import { registerDecisionCommand } from "./commands/decision.js";
import { registerDecisionsCommand } from "./commands/decisions.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerHandoffCommand } from "./commands/handoff.js";
import { registerHookCommand } from "./commands/hook.js";
import { registerImportCommand } from "./commands/import.js";
import { registerInitCommand } from "./commands/init.js";
import { registerNoteCommand } from "./commands/note.js";
import { registerOrientCommand } from "./commands/orient.js";
import { registerPortfolioCommand } from "./commands/portfolio.js";
import { registerProjectCommand } from "./commands/project.js";
import { registerProtocolCommand } from "./commands/protocol.js";
import { registerRefreshCommand } from "./commands/refresh.js";
import { registerReportCommand } from "./commands/report.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerReviewGapsCommand } from "./commands/review-gaps.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerVerifyCommand } from "./commands/verify.js";
import { registerViewCommand } from "./commands/view.js";

/**
 * The identity of the build that is RUNNING, frozen into the bundle by
 * `tsup.config.ts` at build time. `undefined` when this module is loaded from
 * source (tests, `tsx`), where there is no build to be stale.
 *
 * `typeof` guards an identifier esbuild only declares in a built bundle.
 */
declare const __BASOU_BUILD_STAMP__: string | undefined;

type BuildStamp = { version: string; commit: string; builtAt: string };

function readBuildStamp(): BuildStamp | undefined {
  if (typeof __BASOU_BUILD_STAMP__ !== "string") return undefined;
  try {
    return JSON.parse(__BASOU_BUILD_STAMP__) as BuildStamp;
  } catch {
    return undefined;
  }
}

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** The build's own record of itself, or `undefined` when running from source. */
export const BASOU_BUILD = readBuildStamp();

/**
 * The version of the code that is RUNNING.
 *
 * This used to read `package.json` at runtime, on the reasoning that a constant
 * could go stale past a package bump — true, and it fixed that. But it answers
 * with what the SOURCE says, and source moves without a rebuild: `git pull` or
 * `git checkout` leaves `dist` untouched while `package.json` advances. One
 * workspace ran a build a release and a half behind for a full day while
 * `--version` confidently reported the newest release, because the built code
 * and the number it printed came from different places.
 *
 * So the built bundle answers from its own stamp, and only a source checkout —
 * where the source IS the running code — falls back to `package.json`. Neither
 * reading can now disagree with what is executing.
 */
export const BASOU_CLI_VERSION = BASOU_BUILD?.version ?? pkg.version;

/**
 * What `--version` prints. The version stays the FIRST token, so anything
 * parsing the old single-line output with `cut`/`awk` keeps working, and the
 * build identity follows it.
 *
 * The commit is the part that carries the information: two builds of the same
 * version number are exactly the case that went unnoticed, and the version
 * alone cannot tell them apart.
 */
export const BASOU_VERSION_LINE = buildVersionLine();

function buildVersionLine(): string {
  if (BASOU_BUILD === undefined) return `${pkg.version} (source)`;
  const coreBuild = basouCore.BASOU_CORE_BUILD;
  const self = `${BASOU_BUILD.version} (build ${BASOU_BUILD.commit}, ${BASOU_BUILD.builtAt})`;
  // Core is a separate artifact the CLI does not bundle, so a partial rebuild
  // can leave the two at different commits. Only the disagreement is worth
  // printing: when they match, naming core twice says nothing.
  if (coreBuild === undefined || coreBuild.commit === BASOU_BUILD.commit) {
    return self;
  }
  return `${self}; core build ${coreBuild.commit}, ${coreBuild.builtAt}`;
}

/**
 * Build the fully-registered `basou` command tree WITHOUT parsing argv.
 *
 * This is the side-effect-free entry shared by the CLI binary (./index.ts)
 * and any introspection consumer — e.g. the docs generator that renders the
 * command reference from the published `@basou/cli`. Importing this module
 * must never parse `process.argv` or run a command action; `index.ts` owns
 * the single `parseAsync` call.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("basou")
    .description("A harness for steering AI coding agents")
    .version(BASOU_VERSION_LINE)
    // Required so that `basou exec` (and any other passThroughOptions
    // subcommand) can forward unknown flags to the wrapped child.
    .enablePositionalOptions();

  registerInitCommand(program);
  registerStatusCommand(program);
  registerStatsCommand(program);
  registerExecCommand(program);
  registerRunCommand(program);
  registerSessionCommand(program);
  registerImportCommand(program);
  registerRefreshCommand(program);
  registerVerifyCommand(program);
  registerViewCommand(program);
  registerApprovalCommand(program);
  registerDecisionCommand(program);
  registerNoteCommand(program);
  registerTaskCommand(program);
  registerHandoffCommand(program);
  registerDecisionsCommand(program);
  registerReportCommand(program);
  registerOrientCommand(program);
  registerPortfolioCommand(program);
  registerReviewCommand(program);
  registerReviewGapsCommand(program);
  registerProjectCommand(program);
  registerProtocolCommand(program);
  registerChannelCommand(program);
  registerHookCommand(program);

  return program;
}
