import { streamText, type LanguageModel, type ModelMessage, type TextPart, type ToolCallPart, type ToolResultPart } from 'ai'

// 上下文字符预算:消息总字符超预算时对更早历史做 LLM 摘要压缩(≈1 万 token,适配中小模型窗口;可调)
export const CONTEXT_TOKEN_BUDGET = 40_000
// 历史消息条数窗口:预算未超时保持现状(最近 DEFAULT_CONTEXT_WINDOW 条),摘要失败回退同一截断
export const DEFAULT_CONTEXT_WINDOW = 50
// 压缩兜底:即使超预算也至少保留最近 20 条原文
export const SUMMARY_MIN_KEEP = 20
// 摘要生成提示词(与主循环 system 区分,测试/日志可辨识;失败回退截断,不影响主循环)
export const SUMMARY_SYSTEM_PROMPT =
  '你是对话压缩助手。将用户提供的对话记录压缩为要点摘要,保留事实、决策、文件路径、错误信息,200 字以内,只输出摘要本身,不要输出其他内容。'
export const SUMMARY_PREFIX = '以下是更早对话的摘要:\n'
const SUMMARY_BLOCK_HEADING = '## 早期对话记录\n'
const SUMMARY_MAX_OUTPUT_TOKENS = 1024
// 流式超时(与引擎主循环同一配置):半开/断流不永久挂起,由调用方 catch 兜底回退截断
export const DEFAULT_STREAM_TIMEOUT = { firstChunkMs: 60_000, chunkMs: 60_000 }

export interface CompactOptions {
  budget?: number
  // 摘要调用也走 session.fetch(证书校验/TOFU 生效,AGENTS.md §7),与主循环一致
  fetch?: typeof fetch
  abortSignal?: AbortSignal
}

// 长会话上下文压缩:预算超限时对更早历史生成 LLM 摘要置顶,最近消息原文保留
// (至少 SUMMARY_MIN_KEEP 条,即使超预算);摘要调用任何异常/超时 → 回退 lastN 50 硬截断。
// 不落库:仅影响发往模型的 messages,DB 保持完整历史(消息即状态)。
export async function compactMessages(
  history: ModelMessage[],
  model: LanguageModel,
  opts: CompactOptions = {},
): Promise<ModelMessage[]> {
  const budget = opts.budget ?? CONTEXT_TOKEN_BUDGET
  const total = history.reduce((sum, m) => sum + messageLength(m), 0)
  // 预算未超:保持现状(最近 DEFAULT_CONTEXT_WINDOW 条硬截断),不触发摘要
  if (total <= budget) return history.slice(-DEFAULT_CONTEXT_WINDOW)
  // 从后往前保留消息直到预算;至少保留最近 SUMMARY_MIN_KEEP 条(即使超预算)
  let cutIdx = 0
  let keptCount = 0
  let len = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const l = messageLength(history[i])
    if (len + l > budget && keptCount >= SUMMARY_MIN_KEEP) break
    len += l
    keptCount++
    cutIdx = i
  }
  // 剪口落在孤儿 tool 结果行上(其 assistant 已被压缩)→ 一并丢弃,避免 SDK 收到无配对 tool 消息
  while (cutIdx < history.length && history[cutIdx].role === 'tool') cutIdx++
  const earlier = history.slice(0, cutIdx)
  let kept = history.slice(cutIdx)
  // 剪口之后 kept 中仍可能有孤立 tool 结果行(其 tool-call 在更早处被剪除,或历史本就错位)。
  // 收集 kept 内全部 tool-call id,丢弃无配对的 tool 行 —— 保留它们会向 SDK 泄漏孤儿 tool 消息
  const keptCallIds = new Set<string>()
  for (const m of kept) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const p of m.content as ToolCallPart[]) if (p.type === 'tool-call') keptCallIds.add(p.toolCallId)
    }
  }
  if (keptCallIds.size > 0 || kept.some((m) => m.role === 'tool')) {
    kept = kept.filter((m) => {
      if (m.role !== 'tool' || !Array.isArray(m.content)) return true
      return (m.content as ToolResultPart[]).every((p) => p.type !== 'tool-result' || keptCallIds.has(p.toolCallId))
    })
  }
  const block = summarizeText(earlier)
  if (!block.trim()) return kept
  try {
    const summary = await generateSummary(model, block, opts)
    if (!summary.trim()) return kept
    return [{ role: 'user', content: SUMMARY_PREFIX + summary }, ...kept]
  } catch {
    // 摘要失败/超时:回退原硬截断(现状兜底),绝不把会话搞挂
    return history.slice(-DEFAULT_CONTEXT_WINDOW)
  }
}

// 预算近似:content 字符串长度求和;assistant tool-call/tool-result 按 JSON 文本估算。
// 导出:引擎侧 context_usage 事件复用同一口径,显示占用与压缩触发阈值严格一致
export function messageLength(m: ModelMessage): number {
  if (m.role === 'user') return String(m.content).length
  if (!Array.isArray(m.content)) return String(m.content).length
  let len = 0
  for (const part of m.content as Array<{ type: string }>) {
    switch (part.type) {
      case 'text':
        len += (part as TextPart).text.length
        break
      case 'tool-call':
        len += (part as ToolCallPart).toolName.length + JSON.stringify((part as ToolCallPart).input).length
        break
      case 'tool-result':
        len += JSON.stringify((part as ToolResultPart).output).length
        break
      default:
        len += JSON.stringify(part).length
    }
  }
  return len
}

// 压缩块只保留 user/assistant 文本:tool-call/tool-result 是执行噪音,跳过
// (工具轮次的信息已反映在其后 assistant 文本中)
function summarizeText(messages: ModelMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`user: ${String(m.content)}`)
      continue
    }
    if (m.role === 'assistant') {
      const parts = Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []
      const text = parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('')
      if (text.trim()) lines.push(`assistant: ${text}`)
    }
  }
  if (lines.length === 0) return ''
  return SUMMARY_BLOCK_HEADING + lines.join('\n')
}

// 单轮无工具摘要生成(失败由调用方 catch 兜底)
async function generateSummary(model: LanguageModel, block: string, opts: CompactOptions): Promise<string> {
  const result = streamText({
    model,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: block }],
    maxRetries: 0, // 摘要失败即回退截断,不重试
    timeout: DEFAULT_STREAM_TIMEOUT,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  })
  let summary = ''
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') summary += part.text
    if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error))
  }
  return summary
}
