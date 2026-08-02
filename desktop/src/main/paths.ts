import { join } from 'node:path'

let dataDirOverride: string | null = null

export function setDataDirOverride(dir: string | null): void {
  dataDirOverride = dir
}

export function dataDir(): string {
  if (dataDirOverride) return dataDirOverride
  const home = process.env.HOME
  if (process.platform === 'darwin') {
    return join(home ?? '', 'Library', 'Application Support', 'picoaide')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? home ?? '', 'picoaide')
  }
  return join(home ?? '', '.local', 'share', 'picoaide')
}

export function dbPath(): string {
  return join(dataDir(), 'picoaide.db')
}

export function workspaceDir(): string {
  return join(dataDir(), 'workspaces')
}
