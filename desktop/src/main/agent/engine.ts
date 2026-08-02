import { isStepCount, streamText } from 'ai'
import type { LanguageModel, ModelMessage, Tool, ToolCallPart, ToolExecutionOptions, ToolResultPart, ToolSet, TextPart } from 'ai'
import type { AgentEvent } from './events'
import { buildRunConfig, type Mode } from './modes'

export const DEFAULT_MAX_STEPS = 20
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000
export const DEFAULT_CONTEXT_WINDOW = 50
export const DEFAULT_RETRY_COUNT = 1
const ERROR_PREFIX = 'Error: '

// 审批拒绝/超时/取消时抛出,SDK 记为该工具错误并回传模型(模型可见错误并重试)
export class ApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalError'
  }
}

export interface EngineConfig {
  model: LanguageModel
  sysPrompt: string
  maxSteps?: number
  approvalTimeoutMs?: number
  // 上游 5xx/网络错误时的重试次数(默认 1,engine 自管,不用 SDK 指数退避)
  retryCount?: number
  // 注入 session.fetch(证书校验/TOFU 生效,架构设计 §3.3.7)
  fetch?: typeof fetch
}

export interface EngineDeps {
  emit: (ev: AgentEvent) => void
  // Ask 路径依赖 store 做会话/消息持久化;run() 探针路径可不用
  store?: StoreLike
}

export type ConversationStatus = 'running' | 'executing' | 'planning' | 'approved' | 'rejected' | 'done' | 'failed'

export interface AppendMessageInput {
  conversationId: number
  role: 'user' | 'assistant' | 'tool'
  content?: string
  reasoning?: string
  toolCalls?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

// 与 src/main/store/* 模块签名一致(引擎自包含,不 import store)
export interface StoreLike {
  getConversation(id: number): { id: number; status: string } | null
  updateConversationStatus(id: number, status: ConversationStatus): void
  listMessages(conversationId: number): DBMessage[]
  appendMessage(input: AppendMessageInput): number
}

export interface AskInput {
  conversationId: number
  content: string
}

export interface RunOptions {
  content: string
  history?: ModelMessage[]
  mode?: Mode
  tools?: Record<string, Tool>
  highRiskTools?: Set<string>
}

// 与 src/main/store/messages.ts MessageRow 结构一致(引擎自包含,不 import store)
export interface DBMessage {
  role: string
  content: string
  tool_calls?: string
  tool_call_id?: string
  tool_name?: string
  is_error?: number
}

interface ApprovalEntry {
  requestId: string
  toolName: string
  input: unknown
  resolve: () => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class AgentEngine {
  private cfg: EngineConfig
  private deps: EngineDeps
  private queue: ApprovalEntry[] = []
  private active: ApprovalEntry | null = null
  private canceling = false
  private currentAbort: AbortController | null = null

  constructor(cfg: EngineConfig, deps: EngineDeps) {
    this.cfg = {
      maxSteps: DEFAULT_MAX_STEPS,
      approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      retryCount: DEFAULT_RETRY_COUNT,
      ...cfg,
    }
    this.deps = deps
  }

  get pendingApprovalCount(): number {
    return this.queue.length + (this.active ? 1 : 0)
  }

  // Ask 模式:纯聊天、无工具、单步、持久化到 store(架构设计 §3.3.4)
  async ask(input: AskInput): Promise<void> {
    const store = this.deps.store
    if (!store) throw new Error('ask requires a store (EngineDeps.store)')
    const { conversationId, content } = input
    if (!store.getConversation(conversationId)) {
      this.deps.emit({ type: 'error', data: `conversation ${conversationId} not found` })
      throw new Error(`conversation ${conversationId} not found`)
    }
    store.updateConversationStatus(conversationId, 'running')
    // 上下文窗口:发送给 LLM 的历史最多最近 50 条(超出仅存 DB 供 UI 查看)
    const history = store.listMessages(conversationId).map(toModelMessage)
    store.appendMessage({ conversationId, role: 'user', content })
    const messages: ModelMessage[] = [...lastN(history, DEFAULT_CONTEXT_WINDOW), { role: 'user', content }]

    const abort = new AbortController()
    this.currentAbort = abort
    let fullText = ''
    let usage: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 0, completion_tokens: 0 }

    const runOnce = async (): Promise<'done' | 'canceled'> => {
      const result = streamText({
        model: this.cfg.model,
        system: this.cfg.sysPrompt,
        messages,
        tools: {},
        stopWhen: isStepCount(1),
        abortSignal: abort.signal,
        maxRetries: 0, // 引擎自管重试(5xx 重试 1 次),避免指数退避拖死 UI
        ...(this.cfg.fetch ? { fetch: this.cfg.fetch } : {}),
      })
      let outcome: 'done' | 'canceled' = 'done'
      const iter = (async (): Promise<void> => {
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            fullText += part.text
            this.deps.emit({ type: 'text_delta', data: part.text })
          } else if (part.type === 'reasoning-delta') {
            this.deps.emit({ type: 'reasoning_delta', data: part.text })
          } else if (part.type === 'finish') {
            usage = {
              prompt_tokens: part.totalUsage?.inputTokens ?? 0,
              completion_tokens: part.totalUsage?.outputTokens ?? 0,
            }
          } else if (part.type === 'error') {
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          } else if (part.type === 'abort') {
            outcome = 'canceled'
            return
          }
        }
      })()
      // ponytail: 挂起流不主动响应 abort 时 SDK 的 fullStream 不 reject,这里竞速保证 cancel() 立即生效
      iter.catch(() => {}) // 竞速输家分支的迟到 rejection 不外泄
      await Promise.race([
        iter,
        new Promise<never>((_, reject) => {
          const handler = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
          abort.signal.addEventListener('abort', handler, { once: true })
          iter.finally(() => abort.signal.removeEventListener('abort', handler))
        }),
      ])
      return outcome
    }

    try {
      let outcome: 'done' | 'canceled' = 'done'
      for (let attempt = 0; ; attempt++) {
        fullText = ''
        try {
          outcome = await runOnce()
          break
        } catch (err) {
          if (abort.signal.aborted || isAbortError(err)) throw err
          if (attempt < (this.cfg.retryCount ?? 0) && isRetryable(err)) continue
          throw err
        }
      }
      if (outcome === 'canceled') {
        this.markFailed(store, conversationId)
        this.deps.emit({ type: 'canceled', data: { reason: 'user_canceled' } })
        return
      }
      if (store.getConversation(conversationId)) {
        store.appendMessage({ conversationId, role: 'assistant', content: fullText })
        store.updateConversationStatus(conversationId, 'done')
      } else {
        // 会话中途被删:跳过落库,不崩溃(消息即状态:UI 侧已无此会话)
        console.warn(`[agent] conversation ${conversationId} deleted mid-run; skipping writes`)
      }
      this.deps.emit({ type: 'done', data: { usage } })
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) {
        this.markFailed(store, conversationId)
        this.deps.emit({ type: 'canceled', data: { reason: 'user_canceled' } })
      } else {
        this.markFailed(store, conversationId)
        const message = err instanceof Error ? err.message : String(err)
        this.deps.emit({ type: 'error', data: message })
        throw err
      }
    } finally {
      this.currentAbort = null
    }
  }

  private markFailed(store: StoreLike, conversationId: number): void {
    if (store.getConversation(conversationId)) store.updateConversationStatus(conversationId, 'failed')
  }

  async run(opts: RunOptions): Promise<void> {
    const mode = opts.mode ?? 'ask'
    const maxSteps = this.cfg.maxSteps ?? DEFAULT_MAX_STEPS
    const { tools } = buildRunConfig(mode, opts.tools ?? {}, maxSteps)
    const messages: ModelMessage[] = [...(opts.history ?? [])]
    if (opts.content) messages.push({ role: 'user', content: opts.content })

    const abort = new AbortController()
    this.currentAbort = abort
    try {
      // v7 的 streamText 内部就是多步循环:模型调用 → 工具执行(execute 内审批门控)→ 结果回传 → 直到 stopWhen/自然终止
      const result = streamText({
        model: this.cfg.model,
        system: this.cfg.sysPrompt,
        messages,
        tools: this.wrapTools(tools, opts.highRiskTools ?? new Set()) as ToolSet,
        // ponytail: v7 默认 stopWhen=isStepCount(1) 不会把工具结果回传续跑;必须显式给步数预算
        stopWhen: isStepCount(maxSteps),
        abortSignal: abort.signal,
        maxRetries: 0, // 快速失败,由上层循环/用户决定重试;避免模型错误时指数退避拖死 UI
        // 不设 timeout:SDK 的 toolMs 会掐断审批窗口;审批窗口由引擎自管(approvalTimeoutMs)
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          this.deps.emit({ type: 'text_delta', data: part.text })
        } else if (part.type === 'reasoning-delta') {
          this.deps.emit({ type: 'reasoning_delta', data: part.text })
        } else if (part.type === 'finish') {
          this.deps.emit({
            type: 'done',
            data: {
              usage: {
                prompt_tokens: part.totalUsage?.inputTokens ?? 0,
                completion_tokens: part.totalUsage?.outputTokens ?? 0,
              },
            },
          })
        } else if (part.type === 'error') {
          // 抛给外层 catch 统一 emit error + rethrow(避免重复事件)
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        } else if (part.type === 'abort') {
          this.deps.emit({ type: 'canceled', data: { reason: 'user_canceled' } })
          return
        }
      }
    } catch (err) {
      if (abort.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        this.deps.emit({ type: 'canceled', data: { reason: 'user_canceled' } })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.deps.emit({ type: 'error', data: message })
        throw err
      }
    } finally {
      this.currentAbort = null
    }
  }

  confirm(requestId: string, ok: boolean): void {
    const entry =
      this.active?.requestId === requestId ? this.active : this.queue.find((e) => e.requestId === requestId)
    if (!entry) return // 已结(超时/取消)——幂等 no-op
    this.settle(entry, ok ? null : new ApprovalError(`审批拒绝: ${entry.toolName}`))
  }

  cancel(): void {
    this.currentAbort?.abort()
    this.canceling = true
    const all = this.active ? [this.active, ...this.queue] : [...this.queue]
    this.active = null
    this.queue = []
    for (const entry of all) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(new ApprovalError(`已取消: ${entry.toolName}`))
    }
    this.canceling = false
  }

  // ---- 审批门控 ----

  private wrapTools(tools: Record<string, Tool>, highRisk: Set<string>): Record<string, Tool> {
    const out: Record<string, Tool> = {}
    for (const [name, t] of Object.entries(tools)) out[name] = this.wrapTool(name, t, highRisk.has(name))
    return out
  }

  private wrapTool(name: string, t: Tool, needsApproval: boolean): Tool {
    const execute = t.execute
    if (!execute) return t
    return {
      ...t,
      execute: async (input: unknown, options: ToolExecutionOptions<unknown>) => {
        const id = options.toolCallId
        this.deps.emit({ type: 'tool_start', data: { id, name, input } })
        const startedAt = Date.now()
        try {
          if (needsApproval) await this.requestApproval(id, name, input)
          const output = await execute(input, options)
          this.deps.emit({ type: 'tool_end', data: { id, name, output, duration_ms: Date.now() - startedAt } })
          return output
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.deps.emit({ type: 'tool_error', data: { id, name, error: message } })
          throw err // SDK 记为工具错误回传模型
        }
      },
    } as Tool
  }

  private requestApproval(requestId: string, toolName: string, input: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ requestId, toolName, input, resolve, reject })
      this.pump()
    })
  }

  // 确认队列串行:任一时刻最多一个 confirm_required 在等回执
  private pump(): void {
    if (this.active || this.canceling) return
    const entry = this.queue.shift()
    if (!entry) return
    this.active = entry
    this.deps.emit({
      type: 'confirm_required',
      data: {
        request_id: entry.requestId,
        op: entry.toolName,
        target: approvalTarget(entry.toolName, entry.input),
        reason: `执行 ${entry.toolName} 需要确认`,
      },
    })
    entry.timer = setTimeout(() => this.settle(entry, new ApprovalError(`审批超时(${this.cfg.approvalTimeoutMs}ms): ${entry.toolName}`)), this.cfg.approvalTimeoutMs)
  }

  private settle(entry: ApprovalEntry, err: Error | null): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (this.active === entry) this.active = null
    else this.queue = this.queue.filter((e) => e !== entry)
    if (err) entry.reject(err)
    else entry.resolve()
    this.pump()
  }
}

function approvalTarget(toolName: string, input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const rec = input as Record<string, unknown>
    const hit = rec.path ?? rec.target ?? rec.file
    if (typeof hit === 'string') return hit
    return JSON.stringify(input)
  }
  return String(input)
}

// ---- 消息转换(DB 行 ↔ AI SDK 消息) ----

export function toModelMessage(row: DBMessage): ModelMessage {
  if (row.role === 'user') return { role: 'user', content: row.content }
  if (row.role === 'tool') {
    const output = row.is_error ? `${ERROR_PREFIX}${row.content}` : row.content
    return {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: row.tool_call_id ?? '', toolName: row.tool_name ?? '', output: { type: 'text', value: output } }],
    }
  }
  const toolCalls = parseToolCalls(row.tool_calls)
  const parts: (TextPart | ToolCallPart)[] = []
  if (row.content) parts.push({ type: 'text', text: row.content })
  for (const tc of toolCalls) {
    parts.push({ type: 'tool-call', toolCallId: tc.tool_call_id, toolName: tc.tool_name, input: tc.args })
  }
  return { role: 'assistant', content: parts.length > 0 ? parts : '' }
}

export function fromModelMessage(msg: ModelMessage): DBMessage {
  if (msg.role === 'user') return { role: 'user', content: String(msg.content) }
  if (msg.role === 'tool') {
    const part = (msg.content as ToolResultPart[]).find((p) => p.type === 'tool-result')
    if (!part) return { role: 'tool', content: '', is_error: 0 }
    const value = 'value' in part.output ? (part.output.type === 'text' ? part.output.value : JSON.stringify(part.output.value)) : String(part.output)
    const isError = value.startsWith(ERROR_PREFIX)
    return {
      role: 'tool',
      content: isError ? value.slice(ERROR_PREFIX.length) : value,
      tool_call_id: part.toolCallId,
      tool_name: part.toolName,
      is_error: isError ? 1 : 0,
    }
  }
  const contentParts = Array.isArray(msg.content) ? msg.content : []
  const text = contentParts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('')
  const calls = contentParts
    .filter((p) => p.type === 'tool-call')
    .map((p) => {
      const tc = p as ToolCallPart
      return { tool_call_id: tc.toolCallId, tool_name: tc.toolName, args: tc.input }
    })
  return { role: 'assistant', content: text, tool_calls: JSON.stringify(calls) }
}

interface StoredToolCall {
  tool_call_id: string
  tool_name: string
  args: unknown
}

function parseToolCalls(json: string | undefined): StoredToolCall[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed as StoredToolCall[]
  } catch {
    return []
  }
}

function lastN<T>(items: T[], n: number): T[] {
  return items.slice(Math.max(0, items.length - n))
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// 5xx / 上游 / 网络错误才重试;业务错误(审批拒绝等)不重试
const RETRYABLE_RE = /5\d\d|502|503|504|upstream|network|ECONN|ETIMEDOUT|fetch failed/i

function isRetryable(err: unknown): boolean {
  return err instanceof Error && RETRYABLE_RE.test(err.message)
}
