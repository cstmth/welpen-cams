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
// value (same semantics as src/config.ts). Disabled cameras get no path block,
// so their RTSP var is neither required nor relayed by MediaMTX.
const TRUTHY = new Set(["1", "true", "yes", "on"]);
function cameraEnabled(n) {
  const value = process.env[`CAMERA_${n}_ENABLED`];
  if (value === undefined || value === "") return true;
  return TRUTHY.has(value.toLowerCase());
}

// Extract the commented-out camera-template block and generate one real path
// block per configured camera. Cameras are discovered the same way as
// src/config.ts: CAMERA_<n>_YOUTUBE marks a camera as present, numbered
// contiguously from 1 with no upper limit.
const CAMERA_TEMPLATE_RE =
  /^# BEGIN camera-template.*\n([\s\S]*?)^# END camera-template.*\n?/m;
const templateMatch = template.match(CAMERA_TEMPLATE_RE);
if (!templateMatch) {
  console.error(
    "render-mediamtx: could not find the camera-template block in the template"
  );
  process.exit(1);
}

// Strip the leading "# " comment prefix from each line of the template block.
const cameraBlock = templateMatch[1].replace(/^# ?/gm, "");

const cameraBlocks = [];
for (let n = 1; process.env[`CAMERA_${n}_YOUTUBE`] !== undefined; n++) {
  if (!cameraEnabled(n)) continue;
  cameraBlocks.push(cameraBlock.replace(/\$\{N\}/g, String(n)));
}

template = template.replace(CAMERA_TEMPLATE_RE, cameraBlocks.join(""));

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
