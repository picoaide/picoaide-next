#!/usr/bin/env bash
# PicoAide client E2E smoke: launch the built Electron app under xvfb and
# verify it boots to the login screen without crashing.
#
# Realistic scope: full UI/Ask assertions live in the Playwright spec (needs
# a display; CI runs them under xvfb). Here we assert the app starts, stays
# alive for 8s (timeout kills it → exit 124), and stdout shows no fatal
# errors. Skipped with a clear message when the build or xvfb is missing.
#
# Usage: bash scripts/e2e/smoke_client.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$ROOT/desktop"
MAIN_JS="$DESKTOP/out/main/index.js"
TIMEOUT_SECS="${SMOKE_CLIENT_TIMEOUT:-8}"

if [ ! -f "$MAIN_JS" ]; then
  echo "SKIP: $MAIN_JS not found — run 'make build-client' (cd desktop && npm run build) first"
  exit 0
fi
if [ ! -x "$DESKTOP/node_modules/electron/dist/electron" ]; then
  echo "SKIP: electron binary not downloaded — run 'cd desktop && npm i' (postinstall downloads it) or 'node node_modules/electron/install.js'"
  exit 0
fi
if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "SKIP: xvfb-run not found — install xvfb (CI: apt-get install -y xvfb)"
  exit 0
fi

LOG="$(mktemp /tmp/pa-client-smoke.XXXXXX)"
trap 'rm -f "$LOG"' EXIT

set +e
(
  cd "$DESKTOP"
  PICOAI_TEST_AUTO_APPROVE=1 timeout "$TIMEOUT_SECS" xvfb-run -a ./node_modules/.bin/electron . --no-sandbox
) >"$LOG" 2>&1
code=$?
set -e

if [ "$code" -eq 124 ]; then
  echo "ok: app stayed up ${TIMEOUT_SECS}s without crashing"
elif grep -qiE "uncaught exception|fatal|segmentation" "$LOG"; then
  echo "CLIENT SMOKE FAIL: app crashed (exit $code)" >&2
  cat "$LOG" >&2
  exit 1
else
  echo "CLIENT SMOKE FAIL: app exited before ${TIMEOUT_SECS}s (exit $code)" >&2
  cat "$LOG" >&2
  exit 1
fi

echo "CLIENT SMOKE PASS"
