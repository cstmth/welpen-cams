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

// A camera is enabled unless CAMERA_<n>_ENABLED is explicitly set to a falsy
// value (same semantics as src/config.ts). Drop the path block for a disabled
// camera so its RTSP var is neither required nor relayed by MediaMTX.
const TRUTHY = new Set(["1", "true", "yes", "on"]);
function cameraEnabled(n) {
  const value = process.env[`CAMERA_${n}_ENABLED`];
  if (value === undefined || value === "") return true;
  return TRUTHY.has(value.toLowerCase());
}

template = template.replace(
  /\n  camera-(\d+):\n(?:    .*\n?)*/g,
  (block, n) => (cameraEnabled(Number(n)) ? block : "")
);

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
