import { unlinkSync, existsSync } from 'node:fs'
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

function loadElectronModule(): any | null {
  if (typeof require !== 'function') return null
  try {
    const mod = require('electron') as any
    return mod?.safeStorage || mod?.session ? mod : (mod?.default?.safeStorage || mod?.default?.session ? mod.default : null)
  } catch {
    return null
  }
}

async function lazyElectronModule(): Promise<any | null> {
  return loadElectronModule() ?? (await import('electron').catch(() => null))
}

async function lazySafeStorage(): Promise<SafeStorageLike | null> {
  const mod = await lazyElectronModule()
  const ss = mod?.safeStorage ?? mod?.default?.safeStorage
  return ss && typeof ss.isEncryptionAvailable === 'function' ? ss : null
}

async function electronSessionFetch(): Promise<typeof fetch | null> {
  const mod = await lazyElectronModule()
  const f = mod?.session?.defaultSession?.fetch ?? mod?.default?.session?.defaultSession?.fetch
  return typeof f === 'function' ? (f as typeof fetch) : null
}

export async function gatewayFetch(url: string, init?: RequestInit): Promise<Response> {
  const sessionFetch = await electronSessionFetch()
  if (sessionFetch) return sessionFetch(url, init)
  return fetch(url, init)
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
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<any> {
  let res: Response
  try {
    res = await gatewayFetch(`${serverURL}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch (e) {
    throw new AuthError('network', e instanceof Error ? e.message : 'network error')
  }

  let data: any = null
  try {
    data = await res.json()
  } catch {
    data = null
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
