import { isVerbose, renderCliError } from "./lib/error-render.js";
import { buildProgram } from "./program.js";

// Thin binary entry: construction lives in the side-effect-free ./program.ts
// (so the docs generator can import `buildProgram` and introspect the command
// surface without triggering a parse); this file owns the single argv parse.
const program = buildProgram();

program.parseAsync(process.argv).catch((err: unknown) => {
  // Top-level safety net: never print the Error object directly because
  // Node's util.inspect recursively expands `error.cause`, which can carry
  // absolute paths from native fs errors. Delegates to the shared pathless
  // renderer; verbose mode is gated on BASOU_DEBUG only since the failure
  // bypassed the subcommand handler that owns the `-v` flag.
  renderCliError(err, { verbose: isVerbose(undefined) });
  process.exit(1);
});
