import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../paths'
import { getMcpConfig, type McpConfig } from '../gateway/marketplace'
import type { Session } from '../gateway/config'

export interface McpInstalledRecord {
  id: number
  name: string
  transport: string
  command: string
  args: string[]
  url: string
  description: string
  enabled: boolean
  installedAt: string
}

export interface McpInstallerDeps {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

export function defaultMcpDir(): string {
  return join(dataDir(), 'mcp')
}

// ---- 凭证仅内存(每次启动从服务端重拉,不落盘;落盘 config.json 只存非敏感字段)----
const credentials = new Map<number, { env?: Record<string, string>; headers?: Record<string, string> }>()

export function getCredentials(id: number): { env?: Record<string, string>; headers?: Record<string, string> } | undefined {
  return credentials.get(id)
}

export function clearCredentials(): void {
  credentials.clear()
}

function configPath(mcpDir: string, id: number): string {
  return join(mcpDir, String(id), 'config.json')
}

export function readInstalledConfig(mcpDir: string, id: number): McpInstalledRecord | null {
  try {
    const raw = readFileSync(configPath(mcpDir, id), 'utf8')
    const parsed = JSON.parse(raw) as Partial<McpInstalledRecord>
    if (typeof parsed.id !== 'number') return null
    return {
      id: parsed.id,
      name: parsed.name ?? String(parsed.id),
      transport: parsed.transport ?? 'stdio',
      command: parsed.command ?? '',
      args: Array.isArray(parsed.args) ? parsed.args : [],
      url: parsed.url ?? '',
      description: parsed.description ?? '',
      enabled: parsed.enabled !== false,
      installedAt: parsed.installedAt ?? '',
    }
  } catch {
    return null
  }
}

export function installedMcpList(mcpDir: string = defaultMcpDir()): McpInstalledRecord[] {
  if (!existsSync(mcpDir)) return []
  const out: McpInstalledRecord[] = []
  for (const entry of readdirSync(mcpDir)) {
    const rec = readInstalledConfig(mcpDir, Number(entry))
    if (rec) out.push(rec)
  }
  return out.sort((a, b) => a.id - b.id)
}

export interface InstallPluginInput {
  session: Session
  id: number
  deps: McpInstallerDeps
  mcpDir?: string
}

// 建议安装制:拉取配置(凭证服务端解密下发)→ 仅持久化非敏感字段;凭证进内存
export async function installPlugin(input: InstallPluginInput): Promise<McpInstalledRecord> {
  const { session, id, deps } = input
  const dir = input.mcpDir ?? defaultMcpDir()
  const cfg: McpConfig = await getMcpConfig(session, id)
  const record: McpInstalledRecord = {
    id: cfg.id,
    name: cfg.name,
    transport: cfg.transport,
    command: cfg.command,
    args: cfg.args,
    url: cfg.url,
    description: cfg.description,
    enabled: true,
    installedAt: new Date().toISOString(),
  }
  const dirPath = join(dir, String(id))
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(configPath(dir, id), JSON.stringify(record, null, 2), { mode: 0o600 })
  credentials.set(id, { env: cfg.env, headers: cfg.headers })
  return record
}

export function setMcpEnabled(input: { id: number; enabled: boolean; mcpDir?: string }): McpInstalledRecord {
  const dir = input.mcpDir ?? defaultMcpDir()
  const rec = readInstalledConfig(dir, input.id)
  if (!rec) throw new Error(`插件未安装: ${input.id}`)
  rec.enabled = input.enabled
  writeFileSync(configPath(dir, input.id), JSON.stringify(rec, null, 2), { mode: 0o600 })
  return rec
}

export function uninstallPlugin(input: { id: number; mcpDir?: string }): void {
  const dir = input.mcpDir ?? defaultMcpDir()
  rmSync(join(dir, String(input.id)), { recursive: true, force: true })
  credentials.delete(input.id)
}

export interface RefreshResult {
  id: number
  status: 'ok' | 'disabled' | 'retry'
}

// 启动重拉:登录态下对已安装插件重拉 /config → 凭证进内存(不落盘);服务端下架(404)→ 标记停用
export async function refreshPluginCredentials(input: {
  session: Session
  deps: McpInstallerDeps
  mcpDir?: string
}): Promise<RefreshResult[]> {
  const dir = input.mcpDir ?? defaultMcpDir()
  const results: RefreshResult[] = []
  for (const rec of installedMcpList(dir)) {
    try {
      const cfg = await getMcpConfig(input.session, rec.id)
      credentials.set(rec.id, { env: cfg.env, headers: cfg.headers })
      results.push({ id: rec.id, status: 'ok' })
    } catch (e) {
      const kind = (e as { kind?: string }).kind
      if (kind === 'not_found') {
        setMcpEnabled({ id: rec.id, enabled: false, mcpDir: dir })
        credentials.delete(rec.id)
        results.push({ id: rec.id, status: 'disabled' })
      } else if (kind === 'rate_limited') {
        // 限流:插件并未下架,保留凭证与启用状态,如实上报 retry(不谎报 disabled)
        results.push({ id: rec.id, status: 'retry' })
      } else {
        // 网络等瞬态错误:保留原状态,下次启动再试
        results.push({ id: rec.id, status: 'retry' })
      }
    }
  }
  return results
}
