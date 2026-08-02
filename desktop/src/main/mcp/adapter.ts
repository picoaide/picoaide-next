import { z, type ZodType } from 'zod'
import type { Tool } from 'ai'

export interface McpToolLike {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  content: { type: string; text?: string; [k: string]: unknown }[]
  isError?: boolean
}

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

// ---- JSON Schema → zod(轻量转换:type string/number/integer/boolean/array/object/null/enum + required;其余回退 unknown)----
export function inputSchemaToZod(schema: unknown): ZodType {
  if (typeof schema !== 'object' || schema === null) return z.unknown()
  const s = schema as Record<string, unknown>
  switch (s.type) {
    case 'string':
      return Array.isArray(s.enum) && s.enum.length > 0 ? z.enum(s.enum as [string, ...string[]]) : z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array': {
      const items = inputSchemaToZod(s.items)
      return z.array(items as never)
    }
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>
      const keys = Object.keys(props)
      if (keys.length === 0) return z.unknown() // 无属性(含 unsupported 场景)直接透传
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
      const shape: Record<string, ZodType> = {}
      for (const [k, v] of Object.entries(props)) {
        const field = inputSchemaToZod(v)
        shape[k] = required.has(k) ? field : field.optional()
      }
      return z.object(shape)
    }
    default:
      return z.unknown()
  }
}

// MCP 工具结果 → 文本(Agent 上下文)
export function formatMcpResult(result: McpCallResult): string {
  const texts = result.content.filter((c) => c.type === 'text' && c.text !== undefined).map((c) => c.text as string)
  return texts.join('\n')
}

// MCP 工具 → AI SDK v7 Tool(execute 桥接 callTool;插件报错 → 抛错记为 tool_error)
export function toAiSdkTool(mcpTool: McpToolLike, callTool: (name: string, args: unknown) => Promise<McpCallResult>): Tool {
  return {
    description: mcpTool.description ?? mcpTool.name,
    inputSchema: mcpTool.inputSchema ? inputSchemaToZod(mcpTool.inputSchema) : z.object({}),
    execute: async (args: unknown) => {
      const result = await callTool(mcpTool.name, args)
      if (result.isError) {
        throw new Error(formatMcpResult(result) || `插件工具 ${mcpTool.name} 执行失败`)
      }
      return formatMcpResult(result)
    },
  }
}
