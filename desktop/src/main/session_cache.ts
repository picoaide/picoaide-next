import type { Session, BootstrapConfig } from './gateway/config'

// 会话 + bootstrap 内存缓存(登录/深链/重启加载共用一处;index.ts 与 ipc.ts 都从这里读写,
// 避免 index↔ipc 循环依赖)。token 只存内存 + 磁盘 config.json,renderer 永不持有。
let currentSession: Session | null = null
let bootstrapCache: BootstrapConfig | null = null

export const EMPTY_BOOTSTRAP: BootstrapConfig = {
  default_model: '',
  models: [],
  skills: [],
  mcp: [],
  web: { allow_private: false, search_endpoint: '' },
}

export function setCurrentSession(s: Session | null): void {
  currentSession = s
}

export function getCurrentSession(): Session | null {
  return currentSession
}

export function setBootstrapCache(cfg: BootstrapConfig | null): void {
  bootstrapCache = cfg
}

export function getBootstrapCache(): BootstrapConfig {
  return bootstrapCache ?? EMPTY_BOOTSTRAP
}

export function clearCaches(): void {
  currentSession = null
  bootstrapCache = null
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export type UrlValidation = { ok: true; url: string } | { ok: false; error: string }

// 登录地址校验:http(s):// 前缀 + 有主机名;远程主机强制 https,localhost/127.0.0.1 允许 http
export function validateServerURL(raw: string): UrlValidation {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: '请输入服务器地址' }
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return { ok: false, error: '地址需以 http:// 或 https:// 开头' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '地址需以 http:// 或 https:// 开头' }
  }
  if (!u.hostname) return { ok: false, error: '地址缺少主机名' }
  const isLocal = LOCAL_HOSTS.has(u.hostname.toLowerCase())
  if (!isLocal && u.protocol !== 'https:') {
    return { ok: false, error: '远程服务器必须使用 HTTPS 连接' }
  }
  return { ok: true, url: trimmed.replace(/\/+$/, '') }
}

export interface EstablishDeps {
  flow: { saveSession: (s: Session) => Promise<{ persisted: boolean }> }
  getBootstrap: (s: Session) => Promise<{ config: BootstrapConfig; fellBack: boolean }>
  onSessionEstablished?: (session: Session) => void
}

// 登录/深链/重启恢复共用流程:持久化会话 → 置缓存 → 拉 bootstrap(失败容忍:离线时
// 仍可进主界面看历史,UI 显示离线横幅,恢复后 auth:refreshBootstrap 补拉)→ 通知侧方。
// AuthIpcDeps 结构兼容,可整体传入。
export async function establishSession(
  session: Session,
  deps: EstablishDeps,
): Promise<{ session: Session & { persisted: boolean }; bootstrap: BootstrapConfig }> {
  const { persisted } = await deps.flow.saveSession(session)
  setCurrentSession(session)
  let bootstrap = EMPTY_BOOTSTRAP
  try {
    bootstrap = (await deps.getBootstrap(session)).config
  } catch {
    // 离线/令牌无效:保留会话供 UI 展示,createModel 等恢复后再用
  }
  setBootstrapCache(bootstrap)
  deps.onSessionEstablished?.(session)
  return { session: { ...session, persisted }, bootstrap }
}
