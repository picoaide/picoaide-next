import { join } from 'node:path'
import { dataDir } from './paths'
import { getBootstrapCache, getCurrentSession } from './session_cache'
import { getAllowedDirsFromSettings } from './tools/paths'
import { downloadArchive, getMcpConfig, MarketplaceError, type MaskedMcp, type McpConfig, type Skill } from './gateway/marketplace'
import type { BootstrapConfig } from './gateway/config'
import {
  installFromMarketplace,
  listInstalledSkills,
  previewSkillMeta,
  removeSkill,
  SkillInstallError,
  type InstalledSkillRecord,
} from './skill/installer'
import { installPlugin, installedMcpList, setMcpEnabled, uninstallPlugin, type McpInstalledRecord } from './mcp/installer'

export type { InstalledSkillRecord } from './skill/installer'
export type { McpInstalledRecord } from './mcp/installer'

// ---- 对外类型(renderer 与 preload 接线方共用) ----

export interface SettingsInfo {
  serverURL: string
  username: string
  model: string
}

export interface SkillRiskInfo {
  name: string
  version: string
  author: string
  description: string
  entrypoint: string
  dependencies: string[]
  source: string
}

export interface McpRiskInfo {
  id: number
  name: string
  description: string
  transport: string
  command: string
  args: string[]
  url: string
  source: string
}

export interface SkillsListResult {
  suggestions: Skill[]
  installed: Record<string, InstalledSkillRecord>
}

export interface McpListResult {
  suggestions: MaskedMcp[]
  installed: McpInstalledRecord[]
}

export interface PluginIpcDeps {
  // settings 读写(store 模块);skills.installed 存这里
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string): void }
  skillsDir?: string
  mcpDir?: string
  // 与 auth:refreshBootstrap 同流程(取 bootstrap + 缓存)
  refreshBootstrap: () => Promise<BootstrapConfig>
}

// ipc invoke 通道签名(handle 侧)。两阶段安装:
//   install({id}) → { risk } 供 renderer 弹窗确认;install({id, confirmed:true}) → 实际安装
export interface PluginHandlers {
  'settings:info': () => SettingsInfo
  'settings:allowedDirs': (input?: { dirs?: string[] }) => string[]
  'settings:refreshBootstrap': () => Promise<BootstrapConfig>
  'plugin:skills.list': () => SkillsListResult
  'plugin:skills.install': (input: { name: string; confirmed?: boolean }) => Promise<InstalledSkillRecord | { risk: SkillRiskInfo }>
  'plugin:skills.remove': (input: { name: string }) => void
  'plugin:mcp.list': () => McpListResult
  'plugin:mcp.install': (input: { id: number; confirmed?: boolean }) => Promise<McpInstalledRecord | { risk: McpRiskInfo }>
  'plugin:mcp.remove': (input: { id: number }) => void
  'plugin:mcp.toggle': (input: { id: number; enabled: boolean }) => McpInstalledRecord
}

// preload 接线方应暴露的 invoke 包装形状(renderer 按此类型调用)
export interface PluginIpcAPI {
  settingsInfo: () => Promise<SettingsInfo>
  allowedDirs: (dirs?: string[]) => Promise<string[]>
  refreshBootstrap: () => Promise<BootstrapConfig>
  pluginSkillsList: () => Promise<SkillsListResult>
  pluginSkillsInstall: (input: { name: string; confirmed?: boolean }) => Promise<InstalledSkillRecord | { risk: SkillRiskInfo }>
  pluginSkillsRemove: (input: { name: string }) => Promise<void>
  pluginMcpList: () => Promise<McpListResult>
  pluginMcpInstall: (input: { id: number; confirmed?: boolean }) => Promise<McpInstalledRecord | { risk: McpRiskInfo }>
  pluginMcpRemove: (input: { id: number }) => Promise<void>
  pluginMcpToggle: (input: { id: number; enabled: boolean }) => Promise<McpInstalledRecord>
}

// ---- 错误编码(renderer errCode() 从 "CODE: message" 前缀解析) ----

const MCP_ERROR_CODES: Record<string, string> = {
  not_found: 'NOT_FOUND',
  rate_limited: 'RATE_LIMITED',
  auth_expired: 'AUTH_REQUIRED',
  network: 'NETWORK',
  server_error: 'SERVER_ERROR',
}

const SKILL_ERROR_CODES: Record<string, string> = {
  not_found: 'NOT_FOUND',
  rate_limited: 'RATE_LIMITED',
  auth_expired: 'AUTH_REQUIRED',
  network: 'NETWORK',
  server_error: 'SERVER_ERROR',
  safety: 'SAFETY',
  invalid_archive: 'INVALID_PACKAGE',
  version_mismatch: 'VERSION_MISMATCH',
  canceled: 'CANCELED',
}

function toIpcError(e: unknown): never {
  if (e instanceof MarketplaceError) {
    throw new Error(`${MCP_ERROR_CODES[e.kind] ?? 'INTERNAL'}: ${e.message}`)
  }
  if (e instanceof SkillInstallError) {
    throw new Error(`${SKILL_ERROR_CODES[e.kind] ?? 'INTERNAL'}: ${e.message}`)
  }
  throw e instanceof Error ? e : new Error(String(e))
}

function requireSession(): { serverURL: string; username: string; token: string } {
  const session = getCurrentSession()
  if (!session) throw new Error('AUTH_REQUIRED: 未登录')
  return session
}

export function buildPluginHandlers(deps: PluginIpcDeps): Record<string, (...args: never[]) => unknown> {
  const skillsDir = deps.skillsDir ?? join(dataDir(), 'skills')
  const mcpDir = deps.mcpDir ?? join(dataDir(), 'mcp')
  const store = deps.store

  return {
    'settings:info': () => {
      const session = requireSession()
      return {
        serverURL: session.serverURL,
        username: session.username,
        model: getBootstrapCache().default_model,
      }
    },

    // get: 不传参;set: { dirs: [...] } → 保存并返回当前列表
    'settings:allowedDirs': (input?: { dirs?: string[] }) => {
      if (input?.dirs) {
        store.setSetting('allowed_dirs', JSON.stringify(input.dirs))
      }
      return getAllowedDirsFromSettings(store.getSetting)
    },

    'settings:refreshBootstrap': async () => {
      requireSession()
      try {
        return await deps.refreshBootstrap()
      } catch (e) {
        toIpcError(e)
      }
    },

    'plugin:skills.list': () => ({
      suggestions: getBootstrapCache().skills,
      installed: listInstalledSkills(store.getSetting),
    }),

    'plugin:skills.install': async ({ name, confirmed }) => {
      const session = requireSession()
      try {
        if (!confirmed) {
          const meta = await previewSkillMeta(session, name, { ...store, downloadArchive })
          return { risk: { ...meta, source: session.serverURL } }
        }
        return await installFromMarketplace({
          session,
          skillsDir,
          name,
          deps: { ...store, downloadArchive },
          onConfirm: async () => true, // 风险弹窗已在 renderer 侧确认过
        })
      } catch (e) {
        toIpcError(e)
      }
    },

    'plugin:skills.remove': ({ name }) => {
      removeSkill(skillsDir, name, store)
    },

    'plugin:mcp.list': () => ({
      suggestions: getBootstrapCache().mcp,
      installed: installedMcpList(mcpDir),
    }),

    'plugin:mcp.install': async ({ id, confirmed }) => {
      const session = requireSession()
      try {
        if (!confirmed) {
          const cfg: McpConfig = await getMcpConfig(session, id)
          return {
            risk: {
              id: cfg.id,
              name: cfg.name,
              description: cfg.description,
              transport: cfg.transport,
              command: cfg.command,
              args: cfg.args,
              url: cfg.url,
              source: session.serverURL,
            },
          }
        }
        return await installPlugin({ session, id, deps: store, mcpDir })
      } catch (e) {
        toIpcError(e)
      }
    },

    'plugin:mcp.remove': ({ id }) => {
      uninstallPlugin({ id, mcpDir })
    },

    'plugin:mcp.toggle': ({ id, enabled }) => {
      return setMcpEnabled({ id, enabled, mcpDir })
    },
  }
}
