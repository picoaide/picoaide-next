import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadRemoteMcp() {
  return import('./remote_mcp')
}

const session = { serverURL: 'https://gw.example.com', username: 'alice', token: 'tok' }
const ok = (result: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ jsonrpc: '2.0', id: 1, result }),
})

function rpcCall(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.at(-1) ?? fetchMock.mock.calls[0]
  return JSON.parse(call[1].body)
}

describe('kb tools', () => {
  it('kbSearch sends tools/call JSON-RPC and returns result text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ content: [{ type: 'text', text: 'found: doc1, doc2' }], isError: false }))
    vi.stubGlobal('fetch', fetchMock)
    const { kbSearch } = await loadRemoteMcp()

    expect(await kbSearch(session, '报销', 2, 5)).toBe('found: doc1, doc2')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.example.com/api/mcp/knowledge/message')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(rpcCall(fetchMock)).toEqual({
      jsonrpc: '2.0',
      id: expect.any(Number),
      method: 'tools/call',
      params: { name: 'kb_search', arguments: { query: '报销', page: 2, page_size: 5 } },
    })
  })

  it('kbRead/kbList/kbUpload map their params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ content: [{ type: 'text', text: 'ok' }], isError: false }))
    vi.stubGlobal('fetch', fetchMock)
    const { kbRead, kbList, kbUpload } = await loadRemoteMcp()

    await kbRead(session, 42)
    expect(rpcCall(fetchMock).params.arguments).toEqual({ doc_id: 42 })

    await kbList(session, 7)
    expect(rpcCall(fetchMock).params.arguments).toEqual({ folder_id: 7 })

    await kbUpload(session, '标题', '内容', 9)
    expect(rpcCall(fetchMock).params.arguments).toEqual({ title: '标题', content: '内容', folder_id: 9 })
  })

  it('throws KbError when isError is true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ content: [{ type: 'text', text: 'upload forbidden' }], isError: true })))
    const { kbUpload, KbError } = await loadRemoteMcp()

    const err = await kbUpload(session, 't', 'c', 9).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KbError)
    expect((err as Error).message).toBe('upload forbidden')
  })

  it('throws KbError on JSON-RPC error object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }) }))
    const { kbSearch, KbError } = await loadRemoteMcp()

    await expect(kbSearch(session, 'q', 1, 10)).rejects.toMatchObject({ message: 'method not found' })
    expect(KbError).toBeDefined()
  })
})

describe('toolsList', () => {
  it('parses tools array from content[0].text JSON', async () => {
    const tools = [
      { name: 'kb_search', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ content: [{ type: 'text', text: JSON.stringify(tools) }], isError: false })))
    const { toolsList } = await loadRemoteMcp()

    expect(await toolsList(session)).toEqual(tools)
  })

  it('returns raw text when content is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ content: [{ type: 'text', text: 'no tools here' }], isError: false })))
    const { toolsList } = await loadRemoteMcp()

    expect(await toolsList(session)).toEqual([])
  })
})
