import { isAbsolute } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type RunnerConfig =
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string>; fetch?: typeof fetch }

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

// SDK Client.callTool 返回 { content, isError, toolResult? },比 types.js 的 CallToolResult 更宽
export type McpCallResult = { content: { type: string; text?: string }[]; isError?: boolean }

export interface McpRunner {
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: unknown): Promise<McpCallResult>
  close(): Promise<void>
  onDisabled(cb: () => void): () => void
  isDisabled(): boolean
  restartCount(): number
  // 测试钩子:http transport 实际使用的 fetch(TOFU 注入验证)
  readonly transportFetch?: typeof fetch
}

// 白名单二进制:绝对路径,或 npx/node/python3/docker(裸名);args 拒绝 shell 元字符
const BARE_COMMANDS = new Set(['npx', 'node', 'python3', 'docker'])
const SHELL_META = /[;&|`$<>\n]/

export function validateStdioCommand(command: string): string | null {
  if (!command) return '命令为空'
  if (isAbsolute(command)) return null
  if (BARE_COMMANDS.has(command)) return null
  return `MCP 命令不在白名单: ${command}(仅允许绝对路径或 npx/node/python3/docker)`
}

export function validateArgs(args: string[]): string | null {
  for (const a of args) {
    if (SHELL_META.test(a)) return `MCP 参数含 shell 元字符,已拒绝: ${a}`
  }
  return null
}

const MAX_RESTARTS = 1

export function createMcpRunner(config: RunnerConfig): McpRunner {
  if (config.transport === 'http') {
    try {
      new URL(config.url)
    } catch {
      throw new Error(`插件 URL 不合法: ${config.url}`)
    }
  } else {
    const cmdErr = validateStdioCommand(config.command)
    if (cmdErr) throw new Error(cmdErr)
    const argErr = validateArgs(config.args)
    if (argErr) throw new Error(argErr)
  }

  let client: Client | null = null
  let transport: StdioClientTransport | StreamableHTTPClientTransport | null = null
  let restarts = 0
  let disabled = false
  let closing = false
  let lastError: Error | null = null
  const disabledCbs = new Set<() => void>()

  let readyResolve: () => void = () => {}
  let readyReject: (e: Error) => void = () => {}
  const ready: Promise<void> = new Promise((res, rej) => {
    readyResolve = res
    readyReject = rej
  })
  // 预挂处理器:disable 时若无人 await ready,也避免 unhandledRejection(Node 语义)
  ready.catch(() => {})

  // 测试钩子:记录 http transport 实际收到的 fetch(验证 session.fetch 注入)
  let lastTransportFetch: typeof fetch | undefined
  function buildTransport(): StdioClientTransport | StreamableHTTPClientTransport {
    if (config.transport === 'stdio') {
      return new StdioClientTransport({ command: config.command, args: config.args, env: config.env })
    }
    // 注入 session.defaultSession.fetch(证书校验/TOFU 生效,架构设计 §3.3.7),
    // 避免 MCP http 传输用全局 fetch 绕过 TLS 校验
    const opts: Record<string, unknown> = { requestInit: { headers: config.headers } }
    if (config.fetch) {
      opts.fetch = config.fetch
      lastTransportFetch = config.fetch
    }
    return new StreamableHTTPClientTransport(new URL(config.url), opts)
  }

  async function connectOnce(): Promise<void> {
    const t = buildTransport()
    transport = t
    const c = new Client({ name: 'picoaide-client', version: '0.1.0' })
    client = c
    t.onclose = () => {
      if (transport === t && !closing) void fail(new Error('MCP 进程已退出'))
    }
    t.onerror = (e) => {
      if (transport === t) void fail(toError(e))
    }
    await c.connect(t)
    await c.listTools() // 初始化握手完成后再对外服务
  }

  function disable(err: Error): void {
    if (disabled) return
    disabled = true
    lastError = new Error(`MCP 插件已停用: ${err.message}`)
    readyReject(lastError)
    for (const cb of disabledCbs) cb()
  }

  // 所有失败(启动失败/进程崩溃/连接失败)汇聚于此:预算内重启 1 次,再失败 → 停用。
  // connecting 守卫:同一次崩溃的 onclose 与 connect 拒绝只消耗一次预算。
  let connecting = false
  async function fail(err: Error): Promise<void> {
    if (closing || disabled || connecting) return
    if (restarts >= MAX_RESTARTS) {
      disable(err)
      return
    }
    restarts++
    connecting = true
    let connectErr: unknown = null
    try {
      await connectOnce()
    } catch (e) {
      connectErr = e
    } finally {
      connecting = false
    }
    if (connectErr !== null) {
      await fail(toError(connectErr))
    } else {
      readyResolve()
    }
  }

  // 首次启动不消耗重启预算(预算只用于崩溃/失败恢复)
  async function boot(): Promise<void> {
    try {
      await connectOnce()
      readyResolve()
    } catch (e) {
      await fail(toError(e))
    }
  }
  void boot()

  return {
    async listTools(): Promise<McpToolDef[]> {
      try {
        await ready
      } catch {
        // 停用:fallthrough 到统一错误
      }
      if (disabled || !client) throw lastError ?? new Error('MCP 插件不可用')
      const result = await client.listTools()
      return result.tools as McpToolDef[]
    },
    async callTool(name: string, args: unknown): Promise<McpCallResult> {
      try {
        await ready
      } catch {
        // 停用:fallthrough 到统一错误
      }
      if (disabled || !client) throw lastError ?? new Error('MCP 插件不可用')
      return client.callTool({ name, arguments: args as Record<string, unknown> }) as unknown as McpCallResult
    },
    async close(): Promise<void> {
      closing = true
      await transport?.close()
    },
    onDisabled(cb: () => void): () => void {
      disabledCbs.add(cb)
      return () => disabledCbs.delete(cb)
    },
    isDisabled: () => disabled,
    restartCount: () => restarts,
    get transportFetch() {
      return lastTransportFetch
    },
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}
