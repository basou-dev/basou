import { Command } from "commander";
import { registerApprovalCommand } from "./commands/approval.js";
import { registerDecisionCommand } from "./commands/decision.js";
import { registerDecisionsCommand } from "./commands/decisions.js";
import { registerExecCommand } from "./commands/exec.js";
import { registerHandoffCommand } from "./commands/handoff.js";
import { registerInitCommand } from "./commands/init.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommand } from "./commands/task.js";
import { isVerbose, renderCliError } from "./lib/error-render.js";

// Kept in sync with packages/cli/package.json `version` by hand on every
// release. Dynamic read via import.meta + createRequire is a v0.3.x
// candidate so a future release bump cannot drift past `basou --version`
// silently.
const BASOU_CLI_VERSION = "0.3.0";

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
