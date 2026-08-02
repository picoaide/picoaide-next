#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../desktop"

npm run build
npx electron-builder --linux

echo
echo "== Linux packages =="
echo "deb:      $(ls dist/picoaide_*_amd64.deb 2>/dev/null || ls dist/*.deb 2>/dev/null || echo 'not found')"
echo "AppImage: $(ls dist/*.AppImage 2>/dev/null || echo 'not found')"
