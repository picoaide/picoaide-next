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

# Portable 标记:exe 同目录存在 portable.txt → 客户端数据落在运行目录/data
touch dist/win-unpacked/portable.txt
cd dist
rm -f picoaide-windows-portable.zip
zip -qr picoaide-windows-portable.zip win-unpacked
echo "portable zip: $(ls picoaide-windows-portable.zip 2>/dev/null || echo 'not found')"
