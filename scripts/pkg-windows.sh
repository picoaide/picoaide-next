#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../desktop"

npm run build
if ! npx electron-builder --win; then
  echo
  echo "Windows build failed on this host. NSIS cross-build may need a Windows"
  echo "machine or CI runner (GitHub Actions windows-latest)."
  exit 1
fi

echo
echo "== Windows package =="
echo "setup: $(ls dist/*.exe 2>/dev/null || echo 'not found')"
