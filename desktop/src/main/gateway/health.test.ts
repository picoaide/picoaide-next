import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadHealth() {
  return import('./health')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('ping', () => {
  it('returns online on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ user: { id: 1 } }) }))
    const { ping } = await loadHealth()
    expect(await ping('https://gw.example.com', 'tok')).toBe('online')
  })

  it('returns auth_expired on 401 (distinct from offline)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'AUTH_FAILED', message: 'x' } }) }))
    const { ping } = await loadHealth()
    expect(await ping('https://gw.example.com', 'stale')).toBe('auth_expired')
  })

  it('returns offline on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const { ping } = await loadHealth()
    expect(await ping('https://gw.example.com', 'tok')).toBe('offline')
  })
})

describe('createHealthPoller', () => {
  it('polls /api/auth/me at interval and stops', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ user: { id: 1 } }) })
    vi.stubGlobal('fetch', fetchMock)
    const { createHealthPoller } = await loadHealth()

    const cb = vi.fn()
    const poller = createHealthPoller(
      { serverURL: 'https://gw.example.com', username: 'alice', token: 'tok' },
      { intervalMs: 20 },
    )
    poller.start(cb)
    await sleep(100)
    poller.stop()
    const callsAfterStop = fetchMock.mock.calls.length
    await sleep(60)

    expect(callsAfterStop).toBeGreaterThanOrEqual(3)
    expect(cb.mock.calls.every(([s]) => s === 'online')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.example.com/api/auth/me')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(callsAfterStop + 1)
  })
})
