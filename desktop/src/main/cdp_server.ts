// 浏览器插件桥:纯本地 WebSocket JSON-RPC 服务(固定 127.0.0.1:54321)。
// 无鉴权是刻意的零配置设计(架构设计 §3.8/§5/§9):安全边界 = 仅绑定回环地址 +
// 本机进程与客户端同信任级(能读本机文件者本就能作恶);操作类/executeScript 由引擎
// 审批门控兜底;升级路径 = 设置页启用 token(插件同步,默认关闭)。
// 转发模型:第一个连入的客户端被认定为"浏览器插件"(代理目标,负责实际 DOM 操作;
// 断线重连后新连接自动接管);其余客户端(Agent 工具的瞬时 sendCdp 连接)发出的
// browser.* 请求 → 原样转发给插件 → 回执原样转发回请求方。
// (ws 类型声明见 ws.d.ts:@types/ws 未随依赖安装,声明使用到的最小 API 面)

import { WebSocket, WebSocketServer } from 'ws'
import { ToolError } from './tools/paths'

export const DEFAULT_CDP_PORT = 54321

export interface CdpHandler {
  [method: string]: (params: any) => Promise<any> | any
}

export interface CdpServer {
  port: number
  close(): Promise<void>
}

interface Pending {
  ws: WebSocket
  id: number
}

export function startCdpServer(opts: { port?: number; handler?: CdpHandler } = {}): Promise<CdpServer> {
  const port = opts.port ?? DEFAULT_CDP_PORT
  const handler: CdpHandler = opts.handler ?? {}
  return new Promise<CdpServer>((resolve, reject) => {
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    const clients = new Set<WebSocket>()
    const pending = new Map<number, Pending>()
    let extension: WebSocket | null = null
    let settled = false

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
      wss.close()
    }

    const safeSend = (ws: WebSocket, data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    }

    wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') fail(new Error(`端口 ${port} 被占用,请关闭占用程序`))
      else fail(err)
    })

    wss.on('listening', () => {
      settled = true
      resolve({
        port: wss.address()?.port ?? port,
        close: () => {
          for (const c of clients) c.terminate()
          clients.clear()
          return new Promise<void>((res) => wss.close(() => res()))
        },
      })
    })

    const handleMessage = (ws: WebSocket, raw: Buffer) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return // 非 JSON 报文忽略
      }
      if (msg === null || typeof msg !== 'object') return
      const id = msg.id
      if (typeof id !== 'number') return // 通知(无 id)忽略
      const method = msg.method
      if (typeof method !== 'string') {
        // 无 method = 插件回执:命中 pending 则原样转发给请求方(JSON-RPC 响应透传)
        const p = pending.get(id)
        if (p) {
          pending.delete(id)
          safeSend(p.ws, raw.toString())
        }
        return
      }
      const params = msg.params
      if (typeof handler[method] === 'function') {
        Promise.resolve(handler[method](params)).then(
          (result) => safeSend(ws, JSON.stringify({ id, result })),
          (err: unknown) =>
            safeSend(ws, JSON.stringify({ id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } })),
        )
        return
      }
      if (method.startsWith('browser.')) {
        // 转发给插件(第一个连入的客户端);插件断线重连后新连接自动接管。
        // ponytail: 请求方恰为插件自身时(协议上不会发生)按未连接报错,不再向下游转发
        const ext = extension
        if (!ext || ext === ws || ext.readyState !== WebSocket.OPEN) {
          safeSend(ws, JSON.stringify({ id, error: { code: -32000, message: '浏览器插件未连接' } }))
          return
        }
        pending.set(id, { ws, id })
        ext.send(raw.toString())
        return
      }
      safeSend(ws, JSON.stringify({ id, error: { code: -32601, message: 'method not found' } }))
    }

    wss.on('connection', (ws) => {
      clients.add(ws)
      if (!extension) extension = ws // 第一个连入 = 插件(代理目标)
      ws.on('message', (raw: Buffer) => handleMessage(ws, raw))
      ws.on('close', () => {
        clients.delete(ws)
        if (extension === ws) {
          extension = null
          for (const [, p] of pending) {
            safeSend(p.ws, JSON.stringify({ id: p.id, error: { code: -32000, message: '浏览器插件未连接' } }))
          }
          pending.clear()
        } else {
          for (const [id, p] of pending) if (p.ws === ws) pending.delete(id)
        }
      })
    })
  })
}

// 客户端工具侧:连接 127.0.0.1:port,发送 JSON-RPC 请求,等待匹配 id 后返回 result。
// ponytail: 每次调用新建短连接(插件是唯一常连方);并发频繁时再考虑连接池。
let nextRequestId = 1 // 进程内自增,保证并发请求 id 唯一(pending 按 id 索引)

export async function sendCdp(
  method: string,
  params: unknown,
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<any> {
  const port = opts.port ?? DEFAULT_CDP_PORT
  return new Promise<any>((resolve, reject) => {
    const id = nextRequestId++
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      fn()
    }
    const timer = setTimeout(() => {
      ws.close()
      finish(() => reject(new ToolError('浏览器插件未连接')))
    }, opts.timeoutMs ?? 5000)
    ws.on('open', () => ws.send(JSON.stringify({ id, method, params })))
    ws.on('message', (data: Buffer) => {
      let msg: { id?: unknown; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(data.toString()) as typeof msg
      } catch {
        return
      }
      if (msg.id !== id) return
      clearTimeout(timer)
      finish(() => {
        ws.close()
        if (msg.error) reject(new ToolError(msg.error.message ?? '浏览器插件未连接'))
        else resolve(msg.result)
      })
    })
    ws.on('error', () => {
      clearTimeout(timer)
      finish(() => reject(new ToolError('浏览器插件未连接')))
    })
  })
}
