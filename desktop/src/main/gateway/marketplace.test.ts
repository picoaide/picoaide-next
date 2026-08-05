import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadMarketplace() {
  return import('./marketplace')
}

const session = { serverURL: 'https://gw.example.com', username: 'alice', token: 'tok' }
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe('listSkills', () => {
  it('GETs /api/marketplace/skills with Bearer', async () => {
    const skills = [{ name: 'docx', version: '1.0.0', description: 'Word' }]
    const fetchMock = vi.fn().mockResolvedValue(ok({ skills }))
    vi.stubGlobal('fetch', fetchMock)
    const { listSkills } = await loadMarketplace()

    expect(await listSkills(session)).toEqual(skills)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.example.com/api/marketplace/skills')
    expect(init.headers.Authorization).toBe('Bearer tok')
  })
})

describe('downloadArchive', () => {
  it('returns gzip buffer and X-Skill-Version', async () => {
    const gz = Buffer.from('gzipped-data')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/gzip', 'X-Skill-Version': '2.1.0' }),
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { downloadArchive } = await loadMarketplace()

    const { buffer, version } = await downloadArchive(session, 'docx')

    expect(version).toBe('2.1.0')
    expect(Buffer.from(buffer)).toEqual(gz)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.example.com/api/marketplace/skills/docx/archive')
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('rejects archives larger than 50MB', async () => {
    const big = new Uint8Array(50 * 1024 * 1024 + 1)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/gzip', 'X-Skill-Version': '1.0.0' }),
        arrayBuffer: async () => big.buffer,
      }),
    )
    const { downloadArchive, MarketplaceError } = await loadMarketplace()

    const err = await downloadArchive(session, 'docx').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MarketplaceError)
    expect((err as { kind?: string }).kind).toBe('server_error')
  })

  it('rejects non-gzip content-type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    )
    const { downloadArchive, MarketplaceError } = await loadMarketplace()

    const err = await downloadArchive(session, 'docx').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MarketplaceError)
    expect((err as { kind?: string }).kind).toBe('server_error')
  })

  it('throws not_found on 404 and rate_limited on 429', async () => {
    const { downloadArchive, MarketplaceError } = await loadMarketplace()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'x' } }) }))
    let err = await downloadArchive(session, 'gone').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MarketplaceError)
    expect((err as { kind?: string }).kind).toBe('not_found')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { code: 'RATE_LIMITED', message: 'slow' } }) }))
    err = await downloadArchive(session, 'docx').catch((e: unknown) => e)
    expect((err as { kind?: string }).kind).toBe('rate_limited')
  })
})

describe('listMcp', () => {
  it('returns masked list without env/headers', async () => {
    const mcp = [{ id: 1, name: 'kb', description: 'knowledge', recommended: true }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ mcp })))
    const { listMcp } = await loadMarketplace()

    expect(await listMcp(session)).toEqual(mcp)
  })
})

describe('getMcpConfig', () => {
  const cfg = {
    id: 1,
    name: 'kb',
    description: 'knowledge',
    transport: 'stdio',
    command: 'kb-server',
    args: [],
    url: '',
    env: { KB_URL: 'https://kb.internal' },
    headers: { 'X-Api-Key': 'decrypted-secret' },
  }

  it('returns decrypted config', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ config: cfg })))
    const { getMcpConfig } = await loadMarketplace()

    expect(await getMcpConfig(session, 1)).toEqual(cfg)
  })

  it('throws not_found on 404 and rate_limited on 429', async () => {
    const { getMcpConfig, MarketplaceError } = await loadMarketplace()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'x' } }) }))
    let err = await getMcpConfig(session, 999).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MarketplaceError)
    expect((err as { kind?: string }).kind).toBe('not_found')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { code: 'RATE_LIMITED', message: 'slow' } }) }))
    err = await getMcpConfig(session, 1).catch((e: unknown) => e)
    expect((err as { kind?: string }).kind).toBe('rate_limited')
  })
})
