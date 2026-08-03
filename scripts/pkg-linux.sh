#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../desktop"

npm run build
npx electron-builder --linux --dir
# Portable 标记:exe 同目录存在 portable.txt → 客户端数据落在运行目录/data
touch dist/linux-unpacked/portable.txt
cd dist
rm -f picoaide-linux-portable.zip
zip -qr picoaide-linux-portable.zip linux-unpacked

echo
echo "== Linux packages =="
echo "deb:      $(ls picoaide_*_amd64.deb 2>/dev/null || ls *.deb 2>/dev/null || echo 'not found (full build only)')"
echo "AppImage: $(ls *.AppImage 2>/dev/null || echo 'not found (full build only)')"
echo "Portable: $(ls picoaide-linux-portable.zip 2>/dev/null || echo 'not found')"
