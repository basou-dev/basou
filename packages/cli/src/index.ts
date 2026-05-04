import { Command } from "commander";

const BASOU_CLI_VERSION = "0.1.0";

const program = new Command();

program.name("basou").description("Provenance layer for AI development").version(BASOU_CLI_VERSION);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
