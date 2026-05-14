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

const BASOU_CLI_VERSION = "0.1.0";

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
  // Mirror runInit's renderCliError: never print the Error object directly
  // because util.inspect recursively expands `error.cause`, which can carry
  // absolute paths from native fs errors. In verbose mode we expose only
  // the cause's errno-style code (or constructor name as a fallback) — the
  // cause's `message` is suppressed because Node's native fs errors embed
  // the failed path in it.
  const verbose = process.env.BASOU_DEBUG === "1";
  if (err instanceof Error) {
    console.error(err.message);
    if (verbose && err.cause instanceof Error) {
      const code = (err.cause as unknown as Record<string, unknown>).code;
      const label = typeof code === "string" && code.length > 0 ? code : err.cause.constructor.name;
      console.error(`Caused by: ${label}`);
    }
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
