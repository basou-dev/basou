#!/usr/bin/env node
// Regenerate the committed JSON Schema artifacts in packages/core/schemas/ from
// the canonical Zod schemas. Run via `pnpm --filter @basou/core gen:schemas`
// (build first: it imports the built dist). The drift-guard test
// (`json-schema.test.ts`) fails CI if the committed files fall out of sync, so
// this is the one command to re-run after changing a schema.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJsonSchemas, serializeJsonSchema } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "schemas");

await mkdir(outDir, { recursive: true });
const artifacts = buildJsonSchemas();
for (const { name, schema } of artifacts) {
  const file = join(outDir, `${name}.schema.json`);
  await writeFile(file, serializeJsonSchema(schema));
  console.log(`wrote schemas/${name}.schema.json`);
}
console.log(`generated ${artifacts.length} JSON Schema artifact(s)`);
