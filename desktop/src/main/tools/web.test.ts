import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { createWebTools, isPrivateHost, webFetch, webSearch } from './web'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

// lookup 有重载(all:true 时返回数组),vi.mocked 类型落到单地址签名,这里显式断言数组形式
function mockLookup(addrs: { address: string; family: number }[]): void {
  vi.mocked(lookup).mockResolvedValue(addrs as unknown as Awaited<ReturnType<typeof lookup>>)
}

function ok(html: string): Response {
  return new Response(html, { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(lookup).mockReset()
  // 默认解析为公网地址,hostname 类用例不显式设置时走通 SSRF 门控
  mockLookup([{ address: '93.184.216.34', family: 4 }])
})

describe('isPrivateHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.10.10', 'fd00::1', 'fe80::1'])(
    'flags %s as private',
    (host) => expect(isPrivateHost(host)).toBe(true),
  )

  it.each(['example.com', '8.8.8.8', '1.2.3.4', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.255.1.1'])(
    'allows %s',
    (host) => expect(isPrivateHost(host)).toBe(false),
  )
})

describe('webFetch', () => {
  it('fetches and converts html to text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok('<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>')),
    )
    const text = await webFetch('https://example.com/page')
    expect(text).toContain('Title')
    expect(text).toContain('Hello world')
    expect(text).not.toContain('<')
  })

  it('strips script and style blocks', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          ok(`<html><head><style>p { color: red; }</style></head><body><script>if (a < b && c > d) { alert('x'); }</script><p>kept</p></body></html>`),
        ),
    )
    const text = await webFetch('https://example.com/page')
    expect(text).toContain('kept')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color')
    expect(text).not.toContain('script')
  })

  it('throws when body exceeds size limit', async () => {
    const big = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(4096))
        c.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(big, { status: 200 })))
    await expect(webFetch('https://example.com/big', { maxBytes: 1024 })).rejects.toThrow('页面超过大小限制')
  })

  it('aborts with an error when timeout exceeded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            )
          }),
      ),
    )
    await expect(webFetch('https://example.com/slow', { timeoutSec: 0.05 })).rejects.toThrow(/aborted/i)
  })

  it('throws on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })))
    await expect(webFetch('https://example.com/missing')).rejects.toThrow(/404/)
  })

  it('rejects non-http(s) protocols', async () => {
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect(webFetch('file:///etc/passwd')).rejects.toThrow(/http/i)
    await expect(webFetch('ftp://example.com/x')).rejects.toThrow(/http/i)
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects invalid urls', async () => {
    await expect(webFetch('not a url')).rejects.toThrow(/URL/i)
  })

  it('rejects private IP literal by default (SSRF), fetch not called', async () => {
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect(webFetch('http://192.168.1.5/x')).rejects.toThrow(/SSRF/i)
    expect(mock).not.toHaveBeenCalled()
  })

  it('allows private IP when allowPrivate=true', async () => {
    const mock = vi.fn().mockResolvedValue(ok('<p>ok</p>'))
    vi.stubGlobal('fetch', mock)
    expect(await webFetch('http://127.0.0.1:9000/x', { allowPrivate: true })).toBe('ok')
    expect(mock).toHaveBeenCalledOnce()
  })

  it('rejects hostname resolving to a private IP', async () => {
    mockLookup([{ address: "10.0.0.1", family: 4 }])
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect(webFetch('http://intranet.example.com/x')).rejects.toThrow(/SSRF/i)
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects hostname when any resolved address is private', async () => {
    mockLookup([
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::1', family: 6 },
    ])
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect(webFetch('http://example.com/x')).rejects.toThrow(/SSRF/i)
    expect(mock).not.toHaveBeenCalled()
  })

  it('allows hostname resolving to public IPs', async () => {
    mockLookup([{ address: '93.184.216.34', family: 4 }])
    const mock = vi.fn().mockResolvedValue(ok('<p>ok</p>'))
    vi.stubGlobal('fetch', mock)
    expect(await webFetch('http://example.com/x')).toBe('ok')
    expect(mock).toHaveBeenCalledOnce()
  })
})

describe('webSearch', () => {
  it('parses {results:[...]} shape and appends q', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        ok(JSON.stringify({ results: [{ title: 'A', url: 'https://a.com', snippet: 'aaa' }] })),
      )
    vi.stubGlobal('fetch', mock)
    const out = await webSearch('hello', 'https://s.example/api')
    expect(out).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'aaa' }])
    expect(mock.mock.calls[0][0]).toBe('https://s.example/api?q=hello')
  })

  it('parses Google-style {items:[{title,link,snippet}]} shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok(JSON.stringify({ items: [{ title: 'B', link: 'https://b.com', snippet: 'bbb' }] }))),
    )
    const out = await webSearch('hi', 'https://s.example/api')
    expect(out).toEqual([{ title: 'B', url: 'https://b.com', snippet: 'bbb' }])
  })

  it('parses plain array shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok(JSON.stringify([{ title: 'C', url: 'https://c.com', snippet: 'ccc' }]))),
    )
    const out = await webSearch('hi', 'https://s.example/api')
    expect(out).toEqual([{ title: 'C', url: 'https://c.com', snippet: 'ccc' }])
  })

  it('appends &q= when endpoint already has a query', async () => {
    const mock = vi.fn().mockResolvedValue(ok('{}'))
    vi.stubGlobal('fetch', mock)
    await webSearch('hi', 'https://s.example/api?lang=en')
    expect(mock.mock.calls[0][0]).toBe('https://s.example/api?lang=en&q=hi')
  })

  it('uses endpoint ?q= template as-is', async () => {
    const mock = vi.fn().mockResolvedValue(ok('{}'))
    vi.stubGlobal('fetch', mock)
    await webSearch('hello world', 'https://s.example/api?q=')
    expect(mock.mock.calls[0][0]).toBe('https://s.example/api?q=hello%20world')
  })

  it('throws when endpoint is missing', async () => {
    await expect(webSearch('hi', '')).rejects.toThrow('web_search 未配置')
  })

  it('returns [] on non-JSON or unexpected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('<html>captcha</html>')))
    expect(await webSearch('hi', 'https://s.example/api')).toEqual([])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('{"nope":1}')))
    expect(await webSearch('hi', 'https://s.example/api')).toEqual([])
  })
})

describe('createWebTools', () => {
  it('registers web_fetch and web_search', async () => {
    const tools = createWebTools({ allowPrivate: true, searchEndpoint: 'https://s.example/api' })
    expect(Object.keys(tools).sort()).toEqual(['web_fetch', 'web_search'])
    const mock = vi.fn().mockResolvedValue(ok('<p>hi</p>'))
    vi.stubGlobal('fetch', mock)
    const out = await (tools.web_fetch.execute as any)({ url: 'http://127.0.0.1:1/x' }, {})
    expect(out).toBe('hi')
  })

  it('web_fetch enforces SSRF guard from config', async () => {
    const tools = createWebTools({ allowPrivate: false, searchEndpoint: '' })
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect((tools.web_fetch.execute as any)({ url: 'http://10.0.0.1/x' }, {})).rejects.toThrow(/SSRF/i)
    expect(mock).not.toHaveBeenCalled()
  })
})
