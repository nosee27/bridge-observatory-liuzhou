#!/usr/bin/env bash
# Bridge Observatory - local server launcher (Linux / macOS)
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4173}"
URL="http://127.0.0.1:${PORT}"

echo ""
echo "  Bridge Observatory - local server"
echo "  URL: ${URL}"
echo ""
echo "  The 3D scene requires http:// (not file://)."
echo "  Press Ctrl+C to stop the server."
echo ""

node server.js &
SERVER_PID=$!

cleanup() {
  kill "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${URL}" >/dev/null 2>&1 || echo "Open ${URL} manually."
elif command -v open >/dev/null 2>&1; then
  open "${URL}" >/dev/null 2>&1 || echo "Open ${URL} manually."
else
  echo "Open ${URL} in your browser."
fi

wait "${SERVER_PID}"
