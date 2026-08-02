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
    ])
  })

  it('read tools do not require approval', () => {
    const tools = createBrowserTools()
    expect(tools.browser_tab_info.needsApproval).toBeUndefined()
    expect(tools.browser_get_content.needsApproval).toBeUndefined()
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
    await expect(tools.browser_execute_js.execute!({ code: '1+1' }, {} as never)).rejects.toThrow('浏览器插件未连接')
  })

  it('returns the plugin result on success', async () => {
    const srv = await startCdpServer({ port: 0 })
    servers.push(srv)
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${srv.port}`)
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string }
      if (msg.method === 'browser.tabInfo') ws.send(JSON.stringify({ id: msg.id, result: { url: 'u', title: 't' } }))
    })
    const tools = createBrowserTools({ port: srv.port })
    await expect(tools.browser_tab_info.execute!({}, {} as never)).resolves.toEqual({ url: 'u', title: 't' })
    ws.close()
  })
})
