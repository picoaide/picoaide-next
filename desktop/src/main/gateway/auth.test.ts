import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDataDirOverride } from '../paths'
import { sessionPath } from './config'

let tmp: string
const originalPlatform = process.platform

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'picoauth-'))
  setDataDirOverride(tmp)
})

afterEach(() => {
  setDataDirOverride(null)
  vi.unstubAllGlobals()
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

async function loadAuth() {
  return import('./auth')
}

describe('login', () => {
  it('POSTs to /api/auth/login and returns a Session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: 'tok-123', user: { id: 1, username: 'alice' } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { login } = await loadAuth()

    const session = await login('https://gw.example.com', 'alice', 'pw')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.example.com/api/auth/login')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ username: 'alice', password: 'pw' })
    expect(session).toEqual({ serverURL: 'https://gw.example.com', username: 'alice', token: 'tok-123' })
  })

  it('throws AuthError invalid_credentials on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }))
    const { login, AuthError } = await loadAuth()

    await expect(login('https://gw.example.com', 'alice', 'bad')).rejects.toMatchObject({ kind: 'invalid_credentials' })
    expect(new AuthError('invalid_credentials').kind).toBe('invalid_credentials')
  })

  it('throws AuthError network on fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { login } = await loadAuth()

    await expect(login('https://gw.example.com', 'alice', 'pw')).rejects.toMatchObject({ kind: 'network' })
  })

  it('wires an AbortSignal so the request can time out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'tok' }) }))
    const { login } = await loadAuth()

    await login('https://gw.example.com', 'alice', 'pw')

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('fetchJSON', () => {
  it('sends Bearer token and parses JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: 1 }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchJSON } = await loadAuth()

    const data = await fetchJSON('https://gw.example.com', '/api/auth/me', { token: 'tok' })

    expect(data).toEqual({ ok: 1 })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('throws AuthError auth_expired on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'AUTH_FAILED', message: 'expired' } }) }))
    const { fetchJSON } = await loadAuth()

    await expect(fetchJSON('https://gw.example.com', '/api/auth/me', { token: 'old' })).rejects.toMatchObject({
      kind: 'auth_expired',
    })
  })

  it('maps error envelope codes to ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'nope' } }) }))
    const { fetchJSON, ApiError } = await loadAuth()

    const err = await fetchJSON('https://gw.example.com', '/x', { token: 't' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as { code?: string; message?: string }).code).toBe('NOT_FOUND')
    expect((err as { code?: string; message?: string }).message).toBe('nope')
  })

  it('throws AuthError network when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const { fetchJSON } = await loadAuth()

    await expect(fetchJSON('https://gw.example.com', '/x', { token: 't' })).rejects.toMatchObject({ kind: 'network' })
  })

  it('throws ApiError UPSTREAM on 200 with non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token') } }))
    const { fetchJSON, ApiError } = await loadAuth()

    const err = await fetchJSON('https://gw.example.com', '/x', { token: 't' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as { code?: string }).code).toBe('UPSTREAM')
  })

  it('wires an AbortSignal timeout on fetchJSON requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: 1 }) }))
    const { fetchJSON } = await loadAuth()

    await fetchJSON('https://gw.example.com', '/x', { token: 't' })

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('throws AuthError network timeout when the request hangs', async () => {
    // 模拟半开连接:fetch 只响应 abort,不返回(黑洞路由挂起)
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    })))
    const { fetchJSON } = await loadAuth()

    await expect(fetchJSON('https://gw.example.com', '/x', { token: 't', timeoutMs: 20 })).rejects.toMatchObject({
      kind: 'network',
    })
  })
})

describe('session persistence', () => {
  it('encrypts via safeStorage when available and round-trips', async () => {
    vi.doMock('electron', () => ({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(`enc:${s}`),
        decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
      },
    }))
    const { saveSession, loadSession } = await loadAuth()
    const session = { serverURL: 'https://gw.example.com', username: 'alice', token: 'secret-token' }

    const res = await saveSession(session)
    expect(res.persisted).toBe(true)

    const raw = readFileSync(sessionPath(), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.encrypted).toBe(true)
    expect(raw).not.toContain('secret-token')
    expect(await loadSession()).toEqual(session)
  })

  it('falls back to plain JSON 0600 when safeStorage unavailable on non-win32', async () => {
    vi.doMock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
    const { saveSession, loadSession } = await loadAuth()

    const res = await saveSession({ serverURL: 'https://gw.example.com', username: 'bob', token: 'tok' })
    expect(res.persisted).toBe(true)

    const raw = readFileSync(sessionPath(), 'utf8')
    expect(JSON.parse(raw)).toEqual({ encrypted: false, data: expect.any(String) })
    expect(JSON.parse(JSON.parse(raw).data)).toEqual({ serverURL: 'https://gw.example.com', username: 'bob', token: 'tok' })
    expect(statSync(sessionPath()).mode & 0o777).toBe(0o600)
    expect(await loadSession()).toEqual({ serverURL: 'https://gw.example.com', username: 'bob', token: 'tok' })
  })

  it('does not persist on win32 without keychain', async () => {
    vi.doMock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { saveSession } = await loadAuth()

    const res = await saveSession({ serverURL: 'https://gw.example.com', username: 'bob', token: 'tok' })
    expect(res.persisted).toBe(false)
    expect(existsSync(sessionPath())).toBe(false)
  })

  it('clearSession removes the file and loadSession returns null when absent', async () => {
    const { saveSession, clearSession, loadSession } = await loadAuth()

    expect(await loadSession()).toBeNull()
    await saveSession({ serverURL: 'https://gw.example.com', username: 'bob', token: 'tok' })
    expect(await loadSession()).not.toBeNull()
    await clearSession()
    expect(existsSync(sessionPath())).toBe(false)
    expect(await loadSession()).toBeNull()
  })
})
