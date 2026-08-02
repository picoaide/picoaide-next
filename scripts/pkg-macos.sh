#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../desktop"

npm run build
if ! npx electron-builder --mac; then
  echo
  echo "macOS build failed on this host. DMG builds require macOS with Xcode;"
  echo "run on a mac or CI runner (GitHub Actions macos-latest)."
  exit 1
fi

echo
echo "== macOS package =="
echo "dmg: $(ls dist/*.dmg 2>/dev/null || echo 'not found')"
