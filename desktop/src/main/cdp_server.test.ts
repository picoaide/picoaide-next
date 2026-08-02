import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startCdpServer, type CdpServer } from './cdp_server'

const servers: CdpServer[] = []

async function start(opts: { port?: number; handler?: Record<string, (params: unknown) => unknown> } = {}): Promise<CdpServer> {
  const s = await startCdpServer(opts)
  servers.push(s)
  return s
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function rpc(ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { id: number }
      if (msg.id !== id) return
      ws.off('message', onMsg)
      resolve(msg)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

describe('startCdpServer', () => {
  it('connects without authentication (zero-config, loopback only)', async () => {
    const srv = await start({ port: 0 })
    const ws = await connect(srv.port)
    ws.close()
    expect(srv.port).toBeGreaterThan(0)
  })

  it('dispatches JSON-RPC requests to the injected handler', async () => {
    const srv = await start({
      port: 0,
      handler: {
        'browser.tabInfo': () => ({ url: 'https://example.com', title: 'Example' }),
        'browser.getContent': () => 'page text',
      },
    })
    const ws = await connect(srv.port)
    const tabInfo = (await rpc(ws, 1, 'browser.tabInfo')) as { result: { url: string; title: string } }
    expect(tabInfo.result).toEqual({ url: 'https://example.com', title: 'Example' })
    const content = (await rpc(ws, 2, 'browser.getContent')) as { result: string }
    expect(content.result).toBe('page text')
    ws.close()
  })

  it('rejects unknown methods with JSON-RPC -32601', async () => {
    const srv = await start({ port: 0, handler: {} })
    const ws = await connect(srv.port)
    const resp = (await rpc(ws, 1, 'foo.bar')) as { error: { code: number } }
    expect(resp.error.code).toBe(-32601)
    ws.close()
  })

  it('rejects startup with a clear message when the port is occupied', async () => {
    const srv = await start({ port: 0 })
    await expect(startCdpServer({ port: srv.port })).rejects.toThrow(/端口 \d+ 被占用,请关闭占用程序/)
  })

  it('forwards browser.* requests to the extension client and relays the reply', async () => {
    const srv = await start({ port: 0, handler: {} })
    const ext = await connect(srv.port) // 第一个连入 = 插件
    ext.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string }
      if (msg.method === 'browser.tabInfo') ext.send(JSON.stringify({ id: msg.id, result: { url: 'x', title: 'X' } }))
    })
    const requester = await connect(srv.port)
    const resp = (await rpc(requester, 7, 'browser.tabInfo')) as { result: { url: string; title: string } }
    expect(resp.result).toEqual({ url: 'x', title: 'X' })
    requester.close()
    ext.close()
  })

  it('returns 浏览器插件未连接 when no extension client is connected', async () => {
    const srv = await start({ port: 0, handler: {} })
    const ws = await connect(srv.port)
    const resp = (await rpc(ws, 1, 'browser.tabInfo')) as { error: { message: string } }
    expect(resp.error.message).toBe('浏览器插件未连接')
    ws.close()
  })
})
