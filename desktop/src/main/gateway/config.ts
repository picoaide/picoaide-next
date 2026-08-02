import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../paths'

export interface Session {
  serverURL: string
  username: string
  token: string
}

export interface BootstrapConfig {
  default_model: string
  models: { id: string; display_name: string }[]
  skills: { name: string; version: string; description: string }[]
  mcp: { id: number; name: string; description: string; recommended: boolean }[]
  web: { allow_private: boolean; search_endpoint: string }
}

export function sessionPath(): string {
  return join(dataDir(), 'config.json')
}

export function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function writePrivateJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
}
