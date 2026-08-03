// MCP plugin → engine integration helpers (used by index.ts tool registry).
// 官方 @ai-sdk/mcp 客户端(替换手写 runner/adapter):createMCPClient + client.tools()
// 返回 AI SDK 原生工具集(JSON Schema → zod、结果格式化均由 SDK 完成)
import { createMCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from 'ai'
import { installedMcpList, defaultMcpDir, type McpInstalledRecord } from './installer'

export { installedMcpList, defaultMcpDir }
export type { McpInstalledRecord }

// ---- 高危启发式(best-effort 仅减噪,不作安全边界;硬防线 = 安装时风险弹窗)----
const RISK_VERBS = [
  'delete', 'remove', 'write', 'exec', 'shell', 'http', 'post', 'put', 'send', 'upload',
  'publish', 'push', 'sync', 'purge', 'clear', 'truncate', 'unlink', 'rm',
]

export function isHighRiskTool(name: string, description = ''): boolean {
  const lowerName = name.toLowerCase()
  // 名称用 contains(下划线分隔的工具名如 delete_record 无词边界);描述用词边界
  if (RISK_VERBS.some((v) => lowerName.includes(v))) return true
  const hay = description.toLowerCase()
  return RISK_VERBS.some((v) => new RegExp(`\\b${v}\\b`).test(hay))
}

// pluginToolName sanitizes a plugin tool name into a safe AI-SDK tool id.
export function pluginToolName(plugin: string, tool: string): string {
  return `${plugin}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export interface McpToolsClientConfig {
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  // 服务端 HTTP 一律注入 session.fetch(证书校验/TOFU 生效,架构设计 §3.3.7)
  fetch?: typeof fetch
}

export interface McpToolsClientHandle {
  tools: Record<string, Tool>
  close: () => Promise<void>
}

// 官方 @ai-sdk/mcp 客户端:stdio 用 AI SDK transport 实例,http 用 MCP SDK transport(支持 fetch 注入)
export async function createMcpToolsClient(config: McpToolsClientConfig): Promise<McpToolsClientHandle> {
  if (config.transport === 'stdio') {
    const transport = new Experimental_StdioMCPTransport({
      command: config.command ?? '',
      args: config.args ?? [],
      ...(config.env ? { env: config.env } : {}),
    })
    const client = await createMCPClient({ transport })
    const tools = await client.tools()
    return { tools, close: () => client.close() }
  }
  const transport = new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  })
  const client = await createMCPClient({ transport })
  const tools = await client.tools()
  return { tools, close: () => client.close() }
}
