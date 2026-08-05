import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startCdpServer, type CdpServer } from '../cdp_server'
import { createBrowserTools, HIGH_RISK_TOOLS } from './browser'

describe('browser tool registration', () => {
  it('marks operation tools as high risk (needsApproval)', () => {
    expect(HIGH_RISK_TOOLS).toEqual([
      'browser_click',
      'browser_type',
      'browser_navigate',
      'browser_scroll',
      'browser_execute_js',
      'browser_fill',
      'browser_select',
      'browser_dialog',
    ])
  })

  it('read tools do not require approval', () => {
    const tools = createBrowserTools()
    expect(tools.browser_tab_info.needsApproval).toBeUndefined()
    expect(tools.browser_get_content.needsApproval).toBeUndefined()
    expect(tools.browser_wait_for.needsApproval).toBeUndefined()
  })

  it('operation tools are high risk via HIGH_RISK_TOOLS (not SDK needsApproval)', () => {
    const tools = createBrowserTools()
    for (const name of HIGH_RISK_TOOLS) expect(tools[name].needsApproval).toBeUndefined()
  })
})

describe('browser tool execution', () => {
  const servers: CdpServer[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })

  it('fails with a clear error when the browser plugin is not connected', async () => {
    const srv = await startCdpServer({ port: 0 })
    const { port } = srv
    servers.push(srv)
    await srv.close() // 释放端口 → 连接被拒绝
    const tools = createBrowserTools({ port })
    await expect(tools.browser_tab_info.execute!({}, {} as never)).rejects.toThrow('浏览器插件未连接')
    await expect(tools.browser_get_content.execute!({}, {} as never)).rejects.toThrow('浏览器插件未连接')
    await expect(tools.browser_execute_js.execute!({ code: '1+1' }, {} as never)).rejects.toThrow('浏览器插件未连接')
    await expect(tools.browser_fill.execute!({ selector: '#q', value: 'x' }, {} as never)).rejects.toThrow('浏览器插件未连接')
  })

  it('returns the plugin result on success', async () => {
    // 插件连接需经过稳定连接门槛(1s)才被接管为 extension,测试起服时缩短门槛
    const srv = await startCdpServer({ port: 0, adoptDelayMs: 50 })
    servers.push(srv)
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${srv.port}`)
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 80)) // 等接管
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string }
      if (msg.method === 'browser.tabInfo') ws.send(JSON.stringify({ id: msg.id, result: { url: 'u', title: 't' } }))
    })
    const tools = createBrowserTools({ port: srv.port })
    await expect(tools.browser_tab_info.execute!({}, {} as never)).resolves.toEqual({ url: 'u', title: 't' })
    ws.close()
  })

  it('forwards browser_fill to the plugin and returns its result', async () => {
    const srv = await startCdpServer({ port: 0, adoptDelayMs: 50 })
    servers.push(srv)
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${srv.port}`)
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 80)) // 等接管
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string; params: unknown }
      if (msg.method === 'browser.fill') ws.send(JSON.stringify({ id: msg.id, result: true }))
    })
    const tools = createBrowserTools({ port: srv.port })
    await expect(
      tools.browser_fill.execute!({ selector: '#q', value: 'hello' }, {} as never),
    ).resolves.toBe(true)
    ws.close()
  })

  it('forwards browser_get_content to the plugin and returns the semantic snapshot', async () => {
    const srv = await startCdpServer({ port: 0, adoptDelayMs: 50 })
    servers.push(srv)
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${srv.port}`)
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 80)) // 等接管
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string; params: unknown }
      if (msg.method === 'browser.getContent')
        ws.send(JSON.stringify({ id: msg.id, result: '[H1] smoke\n[BUTTON] go' }))
    })
    const tools = createBrowserTools({ port: srv.port })
    await expect(tools.browser_get_content.execute!({}, {} as never)).resolves.toBe(
      '[H1] smoke\n[BUTTON] go',
    )
    ws.close()
  })
})
