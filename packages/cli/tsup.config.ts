import { defineConfig } from "tsup";

// Two entries with different needs:
//   - index.ts   = the `basou` binary; needs the Node shebang banner.
//   - program.ts = the side-effect-free library entry (`@basou/cli/program`)
//     imported by docs tooling to introspect the command tree; must NOT
//     carry a shebang.
// tsup runs an array config in parallel (Promise.all), so neither entry may
// own `clean` — a concurrent clean would race the other's emit. `dist` is
// removed once by the package `build` script before tsup runs.
const shared = {
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: false,
  dts: true,
  sourcemap: true,
} as const;

export default defineConfig([
  { ...shared, entry: ["src/index.ts"], banner: { js: "#!/usr/bin/env node" } },
  { ...shared, entry: ["src/program.ts"] },
]);
