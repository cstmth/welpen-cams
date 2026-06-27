/**
 * Render a mediamtx template into a runtime config by substituting ${ENV_VAR}
 * placeholders with values from the environment.
 *
 * Usage: node mediamtx/render-mediamtx.mjs [template] [output]
 */

import { readFileSync, writeFileSync } from "node:fs";

const TEMPLATE = process.argv[2] ?? "mediamtx/mediamtx.template.yml";
const OUTPUT = process.argv[3] ?? "mediamtx/mediamtx.runtime.yml";

let template;
try {
  template = readFileSync(TEMPLATE, "utf8");
} catch (error) {
  console.error(`render-mediamtx: cannot read ${TEMPLATE}: ${error.message}`);
  process.exit(1);
}

const missing = [];
const rendered = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
  const value = process.env[name];
  if (!value) {
    missing.push(name);
    return "";
  }
  return value;
});

if (missing.length > 0) {
  console.error(
    `render-mediamtx: missing environment variable(s): ${[...new Set(missing)].join(", ")}`
  );
  process.exit(1);
}

writeFileSync(OUTPUT, rendered);
console.log(`render-mediamtx: wrote ${OUTPUT}`);
