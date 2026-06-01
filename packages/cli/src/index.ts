import { createRequire } from "node:module";
import { Command } from "commander";
import { registerApprovalCommand } from "./commands/approval.js";
import { registerDecisionCommand } from "./commands/decision.js";
import { registerDecisionsCommand } from "./commands/decisions.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerHandoffCommand } from "./commands/handoff.js";
import { registerImportCommand } from "./commands/import.js";
import { registerInitCommand } from "./commands/init.js";
import { registerRefreshCommand } from "./commands/refresh.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerViewCommand } from "./commands/view.js";
import { isVerbose, renderCliError } from "./lib/error-render.js";

// Read the CLI release version directly from the sibling package.json so
// `basou --version` cannot drift past a future package-bump (the v0.2/v0.3
// releases both shipped with a stale "0.1.0" constant before the dynamic
// read landed). The relative path is stable across the dev (src/index.ts
// → src/../package.json) and built (dist/index.js → dist/../package.json)
// layouts, since both files sit one directory below the package root.
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };
const BASOU_CLI_VERSION = pkg.version;

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
registerExecCommand(program);
registerRunCommand(program);
registerSessionCommand(program);
registerImportCommand(program);
registerRefreshCommand(program);
registerViewCommand(program);
registerApprovalCommand(program);
registerDecisionCommand(program);
registerTaskCommand(program);
registerHandoffCommand(program);
registerDecisionsCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  // Top-level safety net: never print the Error object directly because
  // Node's util.inspect recursively expands `error.cause`, which can carry
  // absolute paths from native fs errors. Delegates to the shared pathless
  // renderer; verbose mode is gated on BASOU_DEBUG only since the failure
  // bypassed the subcommand handler that owns the `-v` flag.
  renderCliError(err, { verbose: isVerbose(undefined) });
  process.exit(1);
});
