import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

let dataDirOverride: string | null = null

export function setDataDirOverride(dir: string | null): void {
  dataDirOverride = dir
}

// Portable 模式(仅 Windows/Linux):exe 同目录存在 portable.txt(打包脚本生成)→ data 目录 = exe 同目录/data
// macOS 按平台规范走 Application Support,不做 portable(dmg 拖入 Applications 即用,数据不随 .app)
export function isPortable(): boolean {
  if (process.platform === 'darwin') return false
  return existsSync(join(dirname(process.execPath), 'portable.txt'))
}

export function portableDataDir(): string {
  return join(dirname(process.execPath), 'data')
}

function defaultDataDir(): string {
  const home = process.env.HOME
  if (process.platform === 'darwin') {
    return join(home ?? '', 'Library', 'Application Support', 'picoaide')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? home ?? '', 'picoaide')
  }
  return join(home ?? '', '.local', 'share', 'picoaide')
}

export function dataDir(): string {
  if (dataDirOverride) return dataDirOverride
  if (isPortable()) {
    try {
      // 幂等 mkdir;目录只读/被文件占用时抛错 → 回退系统目录
      mkdirSync(portableDataDir(), { recursive: true })
      return portableDataDir()
    } catch {
      // fall through
    }
  }
  return defaultDataDir()
}

export function dbPath(): string {
  return join(dataDir(), 'picoaide.db')
}

export function workspaceDir(): string {
  return join(dataDir(), 'workspaces')
}
