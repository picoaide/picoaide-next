import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadBootstrap() {
  return import('./bootstrap')
}

const fullConfig = {
  default_model: 'qwen2.5-coder:32b',
  models: [
    { id: 'qwen2.5-coder:32b', display_name: 'Qwen Coder 32B' },
    { id: 'deepseek-v3', display_name: 'DeepSeek V3' },
  ],
  skills: [{ name: 'docx', version: '1.0.0', description: 'Word docs' }],
  mcp: [{ id: 1, name: 'kb', description: 'knowledge base', recommended: true }],
  web: { allow_private: false, search_endpoint: 'https://search.example.com' },
}

describe('getBootstrap', () => {
  it('GETs /api/config/bootstrap with Bearer and returns the fixed schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fullConfig })
    vi.stubGlobal('fetch', fetchMock)
    const { getBootstrap } = await loadBootstrap()

    const { config, fellBack } = await getBootstrap({ serverURL: 'https://gw.example.com', username: 'a', token: 'tok' })

    expect(fellBack).toBe(false)
    expect(config).toEqual(fullConfig)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.example.com/api/config/bootstrap')
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('falls back to first model when default_model is invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...fullConfig, default_model: 'gone-model' }) }),
    )
    const { getBootstrap } = await loadBootstrap()

    const { config, fellBack } = await getBootstrap({ serverURL: 'https://gw.example.com', username: 'a', token: 'tok' })

    expect(fellBack).toBe(true)
    expect(config.default_model).toBe('qwen2.5-coder:32b')
    expect(config.models).toEqual(fullConfig.models)
  })

  it('propagates auth_expired on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'AUTH_FAILED', message: 'x' } }) }))
    const { getBootstrap } = await loadBootstrap()

    await expect(getBootstrap({ serverURL: 'https://gw.example.com', username: 'a', token: 'bad' })).rejects.toMatchObject({
      kind: 'auth_expired',
    })
  })
})

describe('validateBootstrap', () => {
  it('keeps config unchanged when default model is valid', async () => {
    const { validateBootstrap } = await loadBootstrap()
    const { config, fellBack } = validateBootstrap(fullConfig)
    expect(fellBack).toBe(false)
    expect(config).toBe(fullConfig)
  })

  it('falls back when models list is empty', async () => {
    const { validateBootstrap } = await loadBootstrap()
    const { fellBack } = validateBootstrap({ ...fullConfig, models: [] })
    expect(fellBack).toBe(true)
  })
})
