import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";

const BASOU_CLI_VERSION = "0.1.0";

const program = new Command();
program.name("basou").description("Provenance layer for AI development").version(BASOU_CLI_VERSION);

registerInitCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  // Mirror runInit's renderCliError: never print the Error object directly
  // because util.inspect recursively expands `error.cause`, which can carry
  // absolute paths from native fs errors.
  const verbose = process.env.BASOU_DEBUG === "1";
  if (err instanceof Error) {
    console.error(err.message);
    if (verbose && err.cause instanceof Error) {
      console.error(`Caused by: ${err.cause.message}`);
    }
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
