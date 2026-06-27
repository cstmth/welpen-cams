#!/usr/bin/env bash
#
# Start the MediaMTX local ingest relay and the Node server together.
# MediaMTX is stopped automatically when this script exits.
#
# Usage:
#   ./mediamtx/start-with-relay.sh                 # runs: node dist/server.js
#   ./mediamtx/start-with-relay.sh npm run dev     # runs a custom server command
#
# Override the MediaMTX binary with MEDIAMTX_BIN if it is not on PATH.

set -euo pipefail

# Always run from the project root (parent of this script's directory)
cd "$(dirname "$0")/.."

# Load .env so MediaMTX can resolve ${CAMERA_N_RTSP} in mediamtx.yml.
# (The Node server loads .env itself; pre-set vars are not overridden.)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Locate the MediaMTX binary: explicit override, PATH, or local ./mediamtx.
MEDIAMTX_BIN="${MEDIAMTX_BIN:-}"
if [ -z "$MEDIAMTX_BIN" ]; then
  if command -v mediamtx >/dev/null 2>&1; then
    MEDIAMTX_BIN="mediamtx"
  elif [ -x "./mediamtx" ]; then
    MEDIAMTX_BIN="./mediamtx"
  else
    echo "[start] ERROR: mediamtx not found. Install it (brew install mediamtx)," >&2
    echo "        place the binary at ./mediamtx, or set MEDIAMTX_BIN." >&2
    exit 1
  fi
fi

# Server command (defaults to the built server)
SERVER_CMD=("$@")
if [ ${#SERVER_CMD[@]} -eq 0 ]; then
  SERVER_CMD=(node dist/server.js)
fi

# Render mediamtx.template.yml -> mediamtx.runtime.yml with the camera URLs
# (MediaMTX does not expand ${VAR} in source fields itself).
echo "[start] Rendering MediaMTX config..."
node mediamtx/render-mediamtx.mjs

echo "[start] Launching MediaMTX ($MEDIAMTX_BIN ./mediamtx/mediamtx.runtime.yml)..."
"$MEDIAMTX_BIN" ./mediamtx/mediamtx.runtime.yml &
MEDIAMTX_PID=$!

# Stop MediaMTX whenever this script exits (normal exit, Ctrl+C, or kill).
cleanup() {
  if kill -0 "$MEDIAMTX_PID" 2>/dev/null; then
    echo "[start] Stopping MediaMTX (pid $MEDIAMTX_PID)..."
    kill "$MEDIAMTX_PID" 2>/dev/null || true
    wait "$MEDIAMTX_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Give MediaMTX a moment to bind its ports and connect to the cameras.
sleep 2

if ! kill -0 "$MEDIAMTX_PID" 2>/dev/null; then
  echo "[start] ERROR: MediaMTX exited during startup. Check mediamtx.yml and camera URLs." >&2
  exit 1
fi

echo "[start] Launching Node server (${SERVER_CMD[*]})..."
"${SERVER_CMD[@]}"
