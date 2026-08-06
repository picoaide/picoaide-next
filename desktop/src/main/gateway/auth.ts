import { unlinkSync, existsSync } from 'node:fs'
import { loadElectronModule } from '../util/electron'
import { readJsonFile, sessionPath, writePrivateJsonFile, type Session } from './config'

export class AuthError extends Error {
  constructor(
    public kind: 'invalid_credentials' | 'auth_expired' | 'network' | 'server_error',
    message?: string,
  ) {
    super(message ?? kind)
    this.name = 'AuthError'
  }
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

async function lazySafeStorage(): Promise<SafeStorageLike | null> {
  const mod = await loadElectronModule()
  const ss = mod?.safeStorage
  return ss && typeof ss.isEncryptionAvailable === 'function' ? ss : null
}

async function electronSessionFetch(): Promise<typeof fetch | null> {
  const mod = await loadElectronModule()
  const f = mod?.session?.defaultSession?.fetch
  return typeof f === 'function' ? (f as typeof fetch) : null
}

export async function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const sessionFetch = await electronSessionFetch()
  const url = typeof input === 'string' ? input : input.toString()
  if (sessionFetch) return sessionFetch(url, init)
  return fetch(input, init)
}

export async function login(serverURL: string, username: string, password: string): Promise<Session> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await gatewayFetch(`${serverURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    })
    if (res.status === 401) throw new AuthError('invalid_credentials')
    if (!res.ok) throw new AuthError('server_error', `HTTP ${res.status}`)
    const data = (await res.json()) as { token?: string }
    if (!data.token) throw new AuthError('server_error', 'missing token in response')
    return { serverURL, username, token: data.token }
  } catch (e) {
    if (e instanceof AuthError) throw e
    if (controller.signal.aborted) throw new AuthError('network', 'timeout')
    throw new AuthError('network', e instanceof Error ? e.message : 'network error')
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJSON(
  serverURL: string,
  path: string,
  opts: { token?: string; method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  // 统一超时(默认 15s):半开连接/黑洞路由下网关请求永不 settle 会卡死
  // 启动(loadSession→bootstrap)、健康轮询(inFlight 冻结)、kb 工具与商城拉取
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000)
  let res: Response
  try {
    res = await gatewayFetch(`${serverURL}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    })
  } catch (e) {
    if (controller.signal.aborted) throw new AuthError('network', 'timeout')
    throw new AuthError('network', e instanceof Error ? e.message : 'network error')
  } finally {
    clearTimeout(timer)
  }

  let data: any = null
  let parseFailed = false
  try {
    data = await res.json()
  } catch {
    parseFailed = true
  }

  // 结构级请求日志(不打正文/token;PICOAI_DEBUG=0 关,测试静音)
  if (process.env.PICOAI_DEBUG !== '0' && process.env.NODE_ENV !== 'test') {
    console.log('[picoaide-debug]', 'gateway', opts.method ?? 'GET', path, '->', res.status, parseFailed ? '(non-JSON body)' : '')
  }

  if (!res.ok) {
    const env = data?.error
    const code = (env?.code as string) ?? `HTTP_${res.status}`
    const message = (env?.message as string) ?? `HTTP ${res.status}`
    if (res.status === 401 || code === 'AUTH_REQUIRED' || code === 'AUTH_FAILED') {
      throw new AuthError('auth_expired', message)
    }
    throw new ApiError(code, message)
  }
  // 200 但 body 不是 JSON(网关异常/反代回 HTML):静默返回 null 会让调用方
  // (kb 工具链)把 undefined 当成功结果 → 落库前 TypeError 整会话 failed;
  // 204 No Content 是合法空响应,放行
  if (parseFailed && res.status !== 204) throw new ApiError('UPSTREAM', '网关响应不是合法 JSON')
  return data
}

export async function saveSession(session: Session): Promise<{ persisted: boolean }> {
  const json = JSON.stringify(session, null, 2)
  const safe = await lazySafeStorage()
  if (safe?.isEncryptionAvailable()) {
    writePrivateJsonFile(sessionPath(), { encrypted: true, data: safe.encryptString(json).toString('base64') })
    return { persisted: true }
  }
  // ponytail: win32 without keychain -> don't persist, memory-only session
  if (process.platform === 'win32') return { persisted: false }
  writePrivateJsonFile(sessionPath(), { encrypted: false, data: json })
  return { persisted: true }
}

export async function loadSession(): Promise<Session | null> {
  const raw = readJsonFile(sessionPath()) as { encrypted?: boolean; data?: string } | null
  if (!raw?.data) return null
  try {
    let json = raw.data
    if (raw.encrypted) {
      const safe = await lazySafeStorage()
      if (!safe) return null
      json = safe.decryptString(Buffer.from(raw.data, 'base64'))
    }
    const s = JSON.parse(json) as Session
    return s.serverURL && s.username && s.token ? s : null
  } catch {
    return null
  }
}

export async function clearSession(): Promise<void> {
  if (existsSync(sessionPath())) unlinkSync(sessionPath())
}
