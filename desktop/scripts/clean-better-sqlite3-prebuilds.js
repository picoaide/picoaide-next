// better-sqlite3 v12+ 安装时下载 node-ABI prebuilds(加载器优先于 build/Release),
// 会覆盖 electron-rebuild 产出的 Electron ABI 版本 → Electron 加载即 SIGSEGV。
// postinstall 清理 prebuilds,统一使用 build/Release 的 Electron ABI 构建。
const fs = require('fs')
fs.rmSync('node_modules/better-sqlite3/prebuilds', { recursive: true, force: true })
