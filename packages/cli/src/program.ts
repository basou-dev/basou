import { createRequire } from "node:module";
import { Command } from "commander";
import { registerApprovalCommand } from "./commands/approval.js";
import { registerDecisionCommand } from "./commands/decision.js";
import { registerDecisionsCommand } from "./commands/decisions.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerHandoffCommand } from "./commands/handoff.js";
import { registerImportCommand } from "./commands/import.js";
import { registerInitCommand } from "./commands/init.js";
import { registerNoteCommand } from "./commands/note.js";
import { registerOrientCommand } from "./commands/orient.js";
import { registerProjectCommand } from "./commands/project.js";
import { registerProtocolCommand } from "./commands/protocol.js";
import { registerRefreshCommand } from "./commands/refresh.js";
import { registerReportCommand } from "./commands/report.js";
import { registerReviewGapsCommand } from "./commands/review-gaps.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerVerifyCommand } from "./commands/verify.js";
import { registerViewCommand } from "./commands/view.js";

// Read the CLI release version directly from the sibling package.json so
// `basou --version` cannot drift past a future package-bump (the v0.2/v0.3
// releases both shipped with a stale "0.1.0" constant before the dynamic
// read landed). The relative path is stable across the dev (src/program.ts
// → src/../package.json) and built (dist/program.js → dist/../package.json)
// layouts, since both files sit one directory below the package root.
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };
export const BASOU_CLI_VERSION = pkg.version;

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
    .description("Provenance layer for AI development")
    .version(BASOU_CLI_VERSION)
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
  registerReviewGapsCommand(program);
  registerProjectCommand(program);
  registerProtocolCommand(program);

  return program;
}
