import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { sendCdp, startCdpServer, type CdpServer } from './cdp_server'

const servers: CdpServer[] = []

async function start(opts: { port?: number; handler?: Record<string, (params: unknown) => unknown>; onExtensionChange?: (connected: boolean) => void } = {}): Promise<CdpServer> {
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

  it('notifies onExtensionChange when the first client connects and disconnects', async () => {
    const changes: boolean[] = []
    const srv = await start({ port: 0, onExtensionChange: (c) => changes.push(c) })
    const ws = await connect(srv.port)
    await new Promise((r) => setTimeout(r, 1100)) // 稳定连接门槛(1s)
    expect(changes).toEqual([true])
    ws.close()
    await new Promise((r) => setTimeout(r, 20))
    expect(changes).toEqual([true, false])
  })

  it('forwards browser.* requests to the extension client and relays the reply', async () => {
    const srv = await start({ port: 0, handler: {} })
    const ext = await connect(srv.port) // 第一个连入 = 插件
    await new Promise((r) => setTimeout(r, 1100)) // 等接管(1s 门槛)
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

  it('does not adopt a short-lived (Agent) connection as the extension', async () => {
    // 稳定连接门槛:毫秒级短连接不得成为 extension(否则插件断开瞬间被误接管,
    // 插件重连被拒 → 转发楔住);短连接存活 <1s 关闭,extension 保持 null
    const srv = await start({ port: 0, handler: {} })
    const agent = await connect(srv.port)
    const changes: boolean[] = []
    const srv2 = await start({ port: 0, onExtensionChange: (c) => changes.push(c) })
    const a2 = await connect(srv2.port)
    a2.close()
    await new Promise((r) => setTimeout(r, 1100))
    expect(changes).toEqual([]) // 短连接未接管
    const ws = await connect(srv2.port)
    const resp = (await rpc(ws, 1, 'browser.tabInfo')) as { error: { message: string } }
    expect(resp.error.message).toBe('浏览器插件未连接') // extension 仍为 null
    ws.close()
    agent.close()
    await srv.close()
  })

  it('returns 浏览器插件未连接 when no extension client is connected', async () => {
    const srv = await start({ port: 0, handler: {} })
    const ws = await connect(srv.port)
    const resp = (await rpc(ws, 1, 'browser.tabInfo')) as { error: { message: string } }
    expect(resp.error.message).toBe('浏览器插件未连接')
    ws.close()
  })

  it('re-adopts a reconnecting extension after the old one dies', async () => {
    // 修复重连楔住:插件断开 → Agent 短连接存活窗口内不得被误接管(1s 门槛),
    // 插件重连后必须能接管,后续 browser.* 转发恢复
    const srv = await start({ port: 0, handler: {} })
    const ext = await connect(srv.port) // 插件
    await new Promise((r) => setTimeout(r, 1100)) // 接管
    const agent = await connect(srv.port) // Agent 短连接(第二个连入,非 extension)
    ext.close() // 插件断开
    await new Promise((r) => setTimeout(r, 50))
    agent.close() // Agent 短连接随即关闭(毫秒级生命周期)
    const plugin2 = await connect(srv.port) // 插件重连
    await new Promise((r) => setTimeout(r, 1100)) // plugin2 稳定后被接管
    const newAgent = await connect(srv.port)
    plugin2.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string }
      if (msg.method === 'browser.tabInfo') plugin2.send(JSON.stringify({ id: msg.id, result: { url: 'y', title: 'Y' } }))
    })
    const resp = (await rpc(newAgent, 9, 'browser.tabInfo')) as { result: { url: string; title: string } }
    expect(resp.result).toEqual({ url: 'y', title: 'Y' })
    plugin2.close()
    newAgent.close()
  })

  it('adopts a new connection while the previous extension is dying', async () => {
    // 竞态窗口:extension 已断开但 close 事件未处理时连入的稳定连接必须能接管
    const srv = await start({ port: 0, handler: {} })
    const ext = await connect(srv.port) // 插件(extension)
    await new Promise((r) => setTimeout(r, 1100))
    ext.terminate() // 立即断开,不等待 close 事件
    const replacement = await connect(srv.port) // 竞态窗口内连入
    await new Promise((r) => setTimeout(r, 1100)) // 稳定后被接管(无论走哪条路径)
    const newAgent = await connect(srv.port)
    replacement.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string }
      if (msg.method === 'browser.tabInfo') replacement.send(JSON.stringify({ id: msg.id, result: { url: 'z', title: 'Z' } }))
    })
    const resp = (await rpc(newAgent, 10, 'browser.tabInfo')) as { result: { url: string; title: string } }
    expect(resp.result).toEqual({ url: 'z', title: 'Z' })
    replacement.close()
    newAgent.close()
  })

  it('immediately re-adopts the oldest live connection when the extension disconnects', async () => {
    // B-2 回归:extension 断开后的重接管不得再起 1s 稳定门槛(与插件重连的 1s 门槛
    // 竞速 → 先到者可能是 Agent 短连接被误设 extension,插件重连被拒);直接接管最老存活连接
    const changes: boolean[] = []
    const srv = await start({ port: 0, onExtensionChange: (c) => changes.push(c) })
    const ext = await connect(srv.port) // 插件
    await new Promise((r) => setTimeout(r, 1100)) // 接管(1s 门槛)
    expect(changes).toEqual([true])
    const agent = await connect(srv.port) // 第二连接(非 extension)
    ext.close()
    // 不等 1s:重接管路径立即生效(旧实现走 adopt 1s 门槛 → 50ms 时 extension 仍为 null)
    await new Promise((r) => setTimeout(r, 50))
    expect(changes).toEqual([true, false, true])
    agent.close()
  })

  it('sendCdp rejects immediately when the bridge disconnects instead of waiting for the timeout', async () => {
    // B-8:请求挂起期间插件/桥断开 → 立即报"插件已断开",不干等 5s 超时
    const srv = await startCdpServer({ port: 0, adoptDelayMs: 50, handler: {} })
    servers.push(srv)
    const ext = await connect(srv.port)
    await new Promise((r) => setTimeout(r, 80)) // 接管
    ext.on('message', () => {}) // 收到请求不回执
    const req = sendCdp('browser.tabInfo', {}, { port: srv.port, timeoutMs: 5000 })
    await new Promise((r) => setTimeout(r, 30)) // 请求已发出、pending
    const start = Date.now()
    await srv.close() // 断开所有客户端(含 sendCdp 的连接)
    await expect(req).rejects.toThrow('浏览器插件已断开')
    expect(Date.now() - start).toBeLessThan(1000) // 旧实现要等满 5s 超时
    ext.close()
  })
})
