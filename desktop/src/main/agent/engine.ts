import {
  isStepCount,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  type ToolApprovalResponse,
  type ToolCallPart,
  type ToolExecutionOptions,
  type ToolResultPart,
  type ToolSet,
  type TextPart,
} from 'ai'
import { z } from 'zod'
import { isAbsolute } from 'node:path'
import type { AgentEvent } from './events'
import { buildRunConfig, type Mode } from './modes'
import { artifactType } from './artifacts'
import { lastUserMessageIndex } from './continue'
import { kbRead, kbSearch, kbList, kbUpload } from '../gateway/remote_mcp'
import { isBoundaryError } from '../tools/paths'
import type { Session } from '../gateway/config'

export const DEFAULT_MAX_STEPS = 20
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000
export const DEFAULT_CONTEXT_WINDOW = 50
export const DEFAULT_RETRY_COUNT = 1
const ERROR_PREFIX = 'Error: '

// 注册表工具可附带按调用参数动态判定的审批谓词(如 command_exec 的白名单策略,架构设计 §3.4)。
// v7 用法:requiresApproval 谓词经 buildToolApproval 转成 streamText 的 toolApproval(SDK 原生审批)
export type GatedTool = Tool & { requiresApproval?: (input: unknown) => boolean }

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
  // 越界引导(3.13):员工确认后将目录加入可访问目录(settings allowed_dirs)
  addAllowedDir?: (dir: string) => void
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
  addArtifact?(input: { conversationId: number; path: string; type: string; size: number }): number
}

export interface AskInput {
  conversationId: number
  content: string
}

export interface CraftInput {
  conversationId: number
  content: string
  tools?: Record<string, GatedTool>
  highRiskTools?: Set<string>
  maxSteps?: number
}

// 重跑恢复输入(架构设计 §3.3.1a):截断到最后一条 user 消息重新多步循环
export interface ContinueInput {
  conversationId: number
  tools?: Record<string, GatedTool>
  highRiskTools?: Set<string>
  maxSteps?: number
  // 恢复时的初始状态:continue 用 running,Plan 批准执行用 executing
  status?: 'running' | 'executing'
}

// Plan 模式(架构设计 §3.3.4):首轮无工具出计划(plan)→ 用户确认(approvePlan)→ 第二轮带 tools 执行
export interface PlanInput {
  conversationId: number
  content: string
}

export interface ApprovePlanInput {
  conversationId: number
  ok: boolean
  tools?: Record<string, GatedTool>
  highRiskTools?: Set<string>
  maxSteps?: number
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

// SDK 原生审批(v7 tool-approval-request/response):挂起的审批请求,等待用户回执或超时拒绝
interface PendingApproval {
  resolve: (ok: boolean) => void
}

export class AgentEngine {
  private cfg: EngineConfig
  private deps: EngineDeps
  private pendingApprovals = new Map<string, PendingApproval>()
  private currentAbort: AbortController | null = null
  // 测试钩子:1=自动允许 0=自动拒绝,仅 env 显式设置时生效。
  // ponytail: 打包剔除靠 electron-vite/electron-builder 构建不含该 env;如需硬剔除可在 CI 构建脚本 `export -n PICOAI_TEST_AUTO_APPROVE`
  private testAutoApprove: boolean | undefined

  constructor(cfg: EngineConfig, deps: EngineDeps) {
    this.cfg = {
      maxSteps: DEFAULT_MAX_STEPS,
      approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      retryCount: DEFAULT_RETRY_COUNT,
      ...cfg,
    }
    this.deps = deps
    const auto = process.env['PICOAI_TEST_AUTO_APPROVE']
    this.testAutoApprove = auto === '1' ? true : auto === '0' ? false : undefined
  }

  get pendingApprovalCount(): number {
    return this.pendingApprovals.size
  }

  // 测试钩子:注入的 session.fetch(TOFU 生效);ipc 层断言接线正确
  get injectedFetch(): typeof fetch | undefined {
    return this.cfg.fetch
  }

  // Ask 模式:纯聊天、无工具、单步、持久化到 store(架构设计 §3.3.4)
  async ask(input: AskInput): Promise<void> {
    const store = this.deps.store
    if (!store) throw new Error('ask requires a store (EngineDeps.store)')
    const { conversationId, content } = input
    this.assertConversation(conversationId)
    await this.runAskLoop(conversationId, content, 'running', 'done')
  }

  // Plan 首轮:无工具、单步出计划(架构设计 §3.3.4);状态保持 planning 等用户确认,approvePlan 发起第二轮
  async plan(input: PlanInput): Promise<void> {
    const store = this.deps.store
    if (!store) throw new Error('plan requires a store (EngineDeps.store)')
    const { conversationId, content } = input
    this.assertConversation(conversationId)
    await this.runAskLoop(conversationId, content, 'planning', 'planning')
  }

  private assertConversation(conversationId: number): void {
    const store = this.deps.store
    if (!store?.getConversation(conversationId)) {
      this.deps.emit({ type: 'error', data: `conversation ${conversationId} not found` })
      throw new Error(`conversation ${conversationId} not found`)
    }
  }

  // 引擎同一时刻只允许一个运行(共享 currentAbort 单槽);第二个并发运行直接拒绝,
  // 避免 chat:ask/chat:continue 双发时 abort 句柄互踩、写入交错。
  private beginRun(): AbortController {
    if (this.currentAbort) {
      throw new Error('已有任务在运行,请先取消或等待完成')
    }
    const abort = new AbortController()
    this.currentAbort = abort
    return abort
  }

  // Ask 与 Plan 首轮共用的单步无工具循环(重试 1 次;cancel → failed)
  private async runAskLoop(
    conversationId: number,
    content: string,
    runStatus: ConversationStatus,
    finalStatus: ConversationStatus,
  ): Promise<void> {
    const store = this.deps.store as StoreLike
    store.updateConversationStatus(conversationId, runStatus)
    // 上下文窗口:发送给 LLM 的历史最多最近 50 条(超出仅存 DB 供 UI 查看)
    const history = store.listMessages(conversationId).map(toModelMessage)
    store.appendMessage({ conversationId, role: 'user', content })
    const messages: ModelMessage[] = [...lastN(history, DEFAULT_CONTEXT_WINDOW), { role: 'user', content }]

    const abort = this.beginRun()
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
            usage.prompt_tokens += part.totalUsage?.inputTokens ?? 0
            usage.completion_tokens += part.totalUsage?.outputTokens ?? 0
          } else if (part.type === 'error') {
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          } else if (part.type === 'abort') {
            outcome = 'canceled'
            return
          }
        }
      })()
      await this.consumeWithAbort(iter, abort)
      return outcome
    }

    try {
      let outcome: 'done' | 'canceled' = 'done'
      for (let attempt = 0; ; attempt++) {
        fullText = ''
        usage = { prompt_tokens: 0, completion_tokens: 0 } // 重试时清零,避免 failed 轮用量重复计数
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
        store.updateConversationStatus(conversationId, finalStatus)
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

  // Craft 模式:完整 Agent 循环(架构设计 §3.3.4)。多步 streamText(步数上限 20),每步落库
  // assistant(含 tool_calls JSON)+ 工具结果行;工具失败/拒绝 → is_error=1 行且结果回传 Agent(循环继续)。
  async craft(input: CraftInput): Promise<void> {
    const store = this.deps.store
    if (!store) throw new Error('craft requires a store (EngineDeps.store)')
    const { conversationId, content } = input
    const maxSteps = input.maxSteps ?? this.cfg.maxSteps ?? DEFAULT_MAX_STEPS
    this.assertConversation(conversationId)
    store.updateConversationStatus(conversationId, 'running')
    // 上下文窗口:发送给 LLM 的历史最多最近 50 条(超出仅存 DB 供 UI 查看)
    const history = store.listMessages(conversationId).map(toModelMessage)
    store.appendMessage({ conversationId, role: 'user', content })
    const messages: ModelMessage[] = [...lastN(history, DEFAULT_CONTEXT_WINDOW), { role: 'user', content }]
    await this.runCraftLoop(conversationId, messages, input.tools ?? {}, input.highRiskTools ?? new Set(), maxSteps)
  }

  // 重跑恢复(架构设计 §3.3.1a):截断到最后一条 user 消息(其后的 assistant/tool 行不进入上下文)重新多步循环
  async continueConversation(input: ContinueInput): Promise<void> {
    const store = this.deps.store
    if (!store) throw new Error('continueConversation requires a store (EngineDeps.store)')
    const { conversationId } = input
    const conv = store.getConversation(conversationId)
    if (!conv) {
      this.deps.emit({ type: 'error', data: `conversation ${conversationId} not found` })
      throw new Error(`conversation ${conversationId} not found`)
    }
    const resumable =
      conv.status === 'running' || conv.status === 'executing' || conv.status === 'planning' || conv.status === 'failed'
    if (!resumable) {
      this.deps.emit({ type: 'error', data: `conversation ${conversationId} 无需继续(status=${conv.status})` })
      throw new Error(`conversation ${conversationId} is not resumable (status=${conv.status})`)
    }
    const rows = store.listMessages(conversationId)
    const idx = lastUserMessageIndex(rows)
    if (idx === -1) {
      this.deps.emit({ type: 'error', data: `conversation ${conversationId} 没有可继续的用户消息` })
      throw new Error(`conversation ${conversationId} has no user message`)
    }
    store.updateConversationStatus(conversationId, input.status ?? 'running')
    const history = rows.slice(0, idx + 1).map(toModelMessage)
    const messages = lastN(history, DEFAULT_CONTEXT_WINDOW)
    const maxSteps = input.maxSteps ?? this.cfg.maxSteps ?? DEFAULT_MAX_STEPS
    await this.runCraftLoop(conversationId, messages, input.tools ?? {}, input.highRiskTools ?? new Set(), maxSteps)
  }

  // Plan 确认(架构设计 §3.3.4):ok → 第二轮带 tools 执行(截断到最后一条 user 消息);!ok → rejected
  async approvePlan(input: ApprovePlanInput): Promise<void> {
    const store = this.deps.store
    if (!store) throw new Error('approvePlan requires a store (EngineDeps.store)')
    const { conversationId, ok } = input
    const conv = store.getConversation(conversationId)
    if (!conv) {
      this.deps.emit({ type: 'error', data: `conversation ${conversationId} not found` })
      throw new Error(`conversation ${conversationId} not found`)
    }
    if (conv.status !== 'planning') return // 幂等:非计划待确认状态不处理(重复点击/迟到回执)
    if (!ok) {
      store.updateConversationStatus(conversationId, 'rejected')
      return
    }
    await this.continueConversation({
      conversationId,
      tools: input.tools,
      highRiskTools: input.highRiskTools,
      maxSteps: input.maxSteps,
      status: 'executing',
    })
  }

  // 多步循环主体(craft 与重跑/Plan 执行共用):每步落库,步数超限报错,完成置 done
  private async runCraftLoop(
    conversationId: number,
    messages: ModelMessage[],
    tools: Record<string, GatedTool>,
    highRisk: Set<string>,
    maxSteps: number,
  ): Promise<void> {
    const store = this.deps.store as StoreLike
    const abort = this.beginRun()
    const wrapped = this.wrapTools(tools, conversationId) as ToolSet

    let canceled = false
    let steps = 0
    let lastStepHadToolCalls = false
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let stepText = ''
    let stepReasoning = ''
    const stepToolCalls: ToolCallPart[] = []
    // v7:成功 → 'tool-result'(output 原始值);抛错 → 'tool-error'(error 原样,SDK 自动回传模型)
    const stepToolResults: Array<{
      type: 'tool-result' | 'tool-error'
      toolCallId: string
      toolName: string
      output?: unknown
      error?: unknown
    }> = []
    // 本轮收集的 SDK 审批请求(tool-approval-request part)
    const approvalParts: Array<{ approvalId: string; toolCall: { toolCallId: string; toolName: string; input: unknown }; isAutomatic?: boolean }> = []

    // 每步结束(finish part)落库:assistant 行(文本+reasoning+tool_calls JSON)+ 每工具一行结果
    const flushStep = (): void => {
      steps++
      lastStepHadToolCalls = stepToolCalls.length > 0
      const contentParts: (TextPart | ToolCallPart)[] = []
      if (stepText) contentParts.push({ type: 'text', text: stepText })
      for (const tc of stepToolCalls) {
        contentParts.push({ type: 'tool-call', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input })
      }
      const assistant = fromModelMessage({ role: 'assistant', content: contentParts } as ModelMessage)
      const toolRows = stepToolResults.map((tr) =>
        tr.type === 'tool-result'
          ? fromModelMessage({
              role: 'tool',
              content: [
                { type: 'tool-result', toolCallId: tr.toolCallId, toolName: tr.toolName, output: tr.output },
              ],
            } as unknown as ModelMessage)
          : {
              role: 'tool' as const,
              content: tr.error instanceof Error ? tr.error.message : String(tr.error),
              tool_call_id: tr.toolCallId,
              tool_name: tr.toolName,
              is_error: 1,
            },
      )
      const reasoning = stepReasoning
      stepText = ''
      stepReasoning = ''
      stepToolCalls.length = 0
      stepToolResults.length = 0
      if (!store.getConversation(conversationId)) return // 会话中途被删:跳过落库,不崩溃
      store.appendMessage({
        conversationId,
        role: 'assistant',
        content: assistant.content,
        reasoning,
        toolCalls: assistant.tool_calls,
      })
      for (const row of toolRows) {
        store.appendMessage({
          conversationId,
          role: 'tool',
          content: row.content,
          toolCallId: row.tool_call_id,
          toolName: row.tool_name,
          isError: row.is_error === 1,
        })
      }
    }

    // SDK v7 原生审批(v7 工具审批:模型执行不暂停,本轮返回 tool-approval-request part;
    // 应用层回传 tool-approval-response 消息后再次调用模型继续)。
    // 外层手动循环:每轮 streamText(1 步),轮末若有审批请求则挂起等用户回执再续跑。
    try {
      while (steps < maxSteps) {
        try {
          const result = streamText({
            model: this.cfg.model,
            system: this.cfg.sysPrompt,
            messages,
            tools: wrapped,
            toolApproval: this.buildToolApproval(tools, highRisk),
            stopWhen: isStepCount(1),
            abortSignal: abort.signal,
            maxRetries: 0, // 快速失败,由上层/用户决定重试
            ...(this.cfg.fetch ? { fetch: this.cfg.fetch } : {}),
          })
          const iter = (async (): Promise<void> => {
            for await (const part of result.fullStream) {
              switch (part.type) {
                case 'text-delta':
                  stepText += part.text
                  this.deps.emit({ type: 'text_delta', data: part.text })
                  break
                case 'reasoning-delta':
                  stepReasoning += part.text
                  this.deps.emit({ type: 'reasoning_delta', data: part.text })
                  break
                case 'tool-call':
                  stepToolCalls.push(part)
                  break
                case 'tool-result':
                case 'tool-error':
                  stepToolResults.push(part)
                  break
                case 'tool-approval-request':
                  // SDK 审批请求:工具未执行;本轮结束后等用户回执
                  if (!part.isAutomatic) approvalParts.push(part)
                  break
                case 'finish-step':
                  flushStep()
                  break
                case 'finish':
                  // 跨轮累加(外层循环每轮独立 streamText,SDK totalUsage 为单轮值)
                  usage.prompt_tokens += part.totalUsage?.inputTokens ?? 0
                  usage.completion_tokens += part.totalUsage?.outputTokens ?? 0
                  break
                case 'error':
                  throw part.error instanceof Error ? part.error : new Error(String(part.error))
                case 'abort':
                  canceled = true
                  return
              }
            }
          })()
          await this.consumeWithAbort(iter, abort)
          // 推进上下文:每轮模型调用结果(含 tool-call/tool-result/审批请求)追加到 messages,
          // 审批 response 才能匹配对应 tool-call(SDK 自动执行已批准工具)
          messages.push(...(await result.response).messages)
        } catch (err) {
          if (abort.signal.aborted || isAbortError(err)) {
            canceled = true
          } else {
            this.markFailed(store, conversationId)
            const message = err instanceof Error ? err.message : String(err)
            this.deps.emit({ type: 'error', data: message })
            throw err
          }
        }
        if (canceled) break

        // 审批回执 → tool-approval-response 消息续跑(SDK 原生机制)。审批轮照常计入
        // 步数预算:模型反复请求审批也会耗尽 maxSteps,不会无限弹确认框。
        if (approvalParts.length > 0) {
          await this.handleApprovalParts(conversationId, approvalParts, messages)
          approvalParts.length = 0
          continue
        }
        // 无审批:本轮有工具调用 → 结果已随 response.messages 回传 → 续跑让模型继续;否则完成
        if (!lastStepHadToolCalls) break
      }

      if (canceled) {
        this.markFailed(store, conversationId)
        this.deps.emit({ type: 'canceled', data: { reason: 'user_canceled' } })
        return
      }
      if (steps >= maxSteps && lastStepHadToolCalls) {
        // 步数超限:Agent 还想继续;UI 后续提供"继续/停止"(继续 = 截断到最后一条 user 消息重发 run)
        this.markFailed(store, conversationId)
        this.deps.emit({ type: 'error', data: '达到最大步骤数' })
        return
      }
      if (store.getConversation(conversationId)) store.updateConversationStatus(conversationId, 'done')
      this.deps.emit({ type: 'done', data: { usage } })
    } finally {
      this.currentAbort = null
    }
  }

  // 竞速消费 fullStream:挂起流不主动响应 abort 时 SDK 的 fullStream 不 reject,这里竞速保证 cancel() 立即生效
  private async consumeWithAbort(iter: Promise<void>, abort: AbortController): Promise<void> {
    iter.catch(() => {}) // 竞速输家分支的迟到 rejection 不外泄
    await Promise.race([
      iter,
      new Promise<never>((_, reject) => {
        const handler = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        abort.signal.addEventListener('abort', handler, { once: true })
        iter.finally(() => abort.signal.removeEventListener('abort', handler))
      }),
    ])
  }

  async run(opts: RunOptions): Promise<void> {
    const mode = opts.mode ?? 'ask'
    const maxSteps = this.cfg.maxSteps ?? DEFAULT_MAX_STEPS
    const { tools } = buildRunConfig(mode, opts.tools ?? {}, maxSteps)
    const messages: ModelMessage[] = [...(opts.history ?? [])]
    if (opts.content) messages.push({ role: 'user', content: opts.content })

    const abort = new AbortController()
    this.currentAbort = abort
    const approvalParts: Array<{ approvalId: string; toolCall: { toolCallId: string; toolName: string; input: unknown }; isAutomatic?: boolean }> = []
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let hadToolCall = false
    let rounds = 0
    try {
      // 外层循环 + SDK 原生审批:审批请求轮结束后等回执,回传 tool-approval-response 续跑;
      // 模型调用工具 → 结果回传后续跑;无工具调用/无审批 → 完成;轮数超 maxSteps → 报错
      for (;;) {
        // maxSteps 检查用上一轮 hadToolCall(本轮尚未执行)
        if (rounds >= maxSteps) {
          if (hadToolCall) {
            this.deps.emit({ type: 'error', data: '达到最大步骤数' })
            return
          }
          break
        }
        rounds++
        hadToolCall = false
        const result = streamText({
          model: this.cfg.model,
          system: this.cfg.sysPrompt,
          messages,
          tools: this.wrapTools(tools) as ToolSet,
          toolApproval: this.buildToolApproval(tools, opts.highRiskTools ?? new Set()),
          stopWhen: isStepCount(1),
          abortSignal: abort.signal,
          maxRetries: 0, // 快速失败,由上层循环/用户决定重试;避免模型错误时指数退避拖死 UI
        })
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            this.deps.emit({ type: 'text_delta', data: part.text })
          } else if (part.type === 'reasoning-delta') {
            this.deps.emit({ type: 'reasoning_delta', data: part.text })
          } else if (part.type === 'tool-approval-request') {
            if (!part.isAutomatic) approvalParts.push(part)
          } else if (part.type === 'tool-call') {
            hadToolCall = true
          } else if (part.type === 'finish') {
            usage.prompt_tokens += part.totalUsage?.inputTokens ?? 0
            usage.completion_tokens += part.totalUsage?.outputTokens ?? 0
          } else if (part.type === 'error') {
            // 抛给外层 catch 统一 emit error + rethrow(避免重复事件)
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          } else if (part.type === 'abort') {
            this.deps.emit({ type: 'canceled', data: { reason: 'user_canceled' } })
            return
          }
        }
        // 推进上下文(审批 response 匹配 tool-call 依赖完整消息历史)
        messages.push(...(await result.response).messages)
        if (approvalParts.length > 0) {
          await this.handleApprovalParts(undefined, approvalParts, messages)
          approvalParts.length = 0
          continue
        }
        if (hadToolCall) continue
        break
      }
      this.deps.emit({ type: 'done', data: { usage } })
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

  // SDK 审批回执:resolve 挂起的审批请求(SDK 机制,60s 超时由 awaitApproval 自管)
  confirm(requestId: string, ok: boolean): void {
    this.pendingApprovals.get(requestId)?.resolve(ok)
  }

  cancel(): void {
    this.currentAbort?.abort()
    // 挂起的审批全部按拒绝结清(迟到回执 no-op);循环退出后不续跑
    for (const pending of this.pendingApprovals.values()) pending.resolve(false)
    this.pendingApprovals.clear()
  }

  // ---- 工具包装(事件 + 越界引导;审批由 SDK toolApproval 处理) ----

  private wrapTools(tools: Record<string, GatedTool>, conversationId?: number): Record<string, Tool> {
    const out: Record<string, Tool> = {}
    for (const [name, t] of Object.entries(tools)) out[name] = this.wrapTool(name, t, conversationId)
    return out
  }

  // 测试钩子:包装单个工具(越界引导单测用;审批走 SDK toolApproval,不入 wrapTool)
  wrapToolForTest(name: string, t: GatedTool): Tool {
    return this.wrapTool(name, t)
  }

  private wrapTool(name: string, t: GatedTool, conversationId?: number): Tool {
    const execute = t.execute
    if (!execute) return t
    return {
      ...t,
      execute: async (input: unknown, options: ToolExecutionOptions<unknown>) => {
        const id = options.toolCallId
        this.deps.emit({ type: 'tool_start', data: { id, name, input } })
        const startedAt = Date.now()
        try {
          // 审批由 SDK toolApproval 配置处理(v7 原生,不再包一层)
          const output = await this.runWithBoundaryGuide(id, name, input, options, execute)
          this.maybeEmitArtifact(conversationId, output)
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

  // 越界引导:工具访问可访问目录外路径 → 弹窗"是否将 X 加入可访问目录?" → 确认后加入并重试一次(旗舰场景一键授权)
  // 走 SDK 审批机制:以 allow_dir 为审批名发出 confirm_required,回执 ok 后授权重试
  private async runWithBoundaryGuide(
    id: string,
    name: string,
    input: unknown,
    options: ToolExecutionOptions<unknown>,
    execute: (input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await execute(input, options)
    } catch (err) {
      const boundary = isBoundaryError(err)
      if (!boundary || !this.deps.addAllowedDir) throw err
      const dir = boundary.path
      this.deps.emit({
        type: 'confirm_required',
        data: {
          request_id: id,
          tool_call_id: id,
          op: 'allow_dir',
          target: dir,
          reason: `是否将 ${dir} 加入可访问目录?`,
        },
      })
      const ok = await this.awaitApproval(id)
      if (!ok) throw err // 拒绝/超时:按原越界错误回传模型
      this.deps.addAllowedDir(dir)
      // 授权后自动重试一次
      return execute(input, options)
    }
  }

  // 审批请求挂起:60s 超时自动拒绝;confirm() 回执结清。测试钩子 PICOAI_TEST_AUTO_APPROVE 直通
  private awaitApproval(requestId: string): Promise<boolean> {
    if (this.testAutoApprove !== undefined) {
      return Promise.resolve(this.testAutoApprove)
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId)
        resolve(false)
      }, this.cfg.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS)
      this.pendingApprovals.set(requestId, {
        resolve: (ok) => {
          clearTimeout(timer)
          this.pendingApprovals.delete(requestId)
          resolve(ok)
        },
      })
    })
  }

  // SDK 原生审批续跑:逐个发 confirm_required → 等回执 → 收集 response,合并为一条 tool 消息续跑(docs 语义)
  private async handleApprovalParts(conversationId: number | undefined, parts: Array<{ approvalId: string; toolCall: { toolCallId: string; toolName: string; input: unknown }; isAutomatic?: boolean }>, messages: ModelMessage[]): Promise<void> {
    const responses: ToolApprovalResponse[] = []
    for (const part of parts) {
      // 测试钩子(PICOAI_TEST_AUTO_APPROVE)直接结清,不发 confirm_required(与旧门控语义一致)
      if (this.testAutoApprove === undefined) {
        this.deps.emit({
          type: 'confirm_required',
          data: {
            request_id: part.approvalId,
            tool_call_id: part.approvalId,
            op: part.toolCall.toolName,
            target: approvalTarget(part.toolCall.toolName, part.toolCall.input),
            reason: `执行 ${part.toolCall.toolName} 需要确认`,
          },
        })
      }
      const ok = await this.awaitApproval(part.approvalId)
      responses.push({
        type: 'tool-approval-response',
        approvalId: part.approvalId,
        approved: ok,
        reason: ok ? '用户已批准' : '用户拒绝或超时',
      })
      if (!ok && this.deps.store?.getConversation(conversationId)) {
        // 拒绝必须落一条 is_error tool 行:否则 DB 里 assistant(tool_call) 无配对结果,
        // 下次发消息/重跑从历史加载时 SDK 抛 MissingToolResultsError → 会话 failed
        this.deps.store.appendMessage({
          conversationId,
          role: 'tool',
          content: '用户拒绝或超时',
          toolCallId: part.toolCall.toolCallId,
          toolName: part.toolCall.toolName,
          isError: true,
        })
      }
    }
    messages.push({ role: 'tool', content: responses })
  }

  // 把 requiresApproval 谓词 + highRiskTools 静态标记转成 SDK toolApproval 配置(动态判定)
  private buildToolApproval(
    tools: Record<string, GatedTool>,
    highRisk: Set<string>,
  ): Record<string, (input: unknown) => Promise<'user-approval' | 'approved' | undefined>> {
    const out: Record<string, (input: unknown) => Promise<'user-approval' | 'approved' | undefined>> = {}
    for (const [name, t] of Object.entries(tools)) {
      if (highRisk.has(name) || t.requiresApproval) {
        out[name] = async (input: unknown) => {
          if (highRisk.has(name)) return 'user-approval'
          if (t.requiresApproval?.(input) === true) return 'user-approval'
          return undefined
        }
      }
    }
    return out
  }

  // 产物提取:工具结果含绝对路径 {path, size?} → artifact 事件 + artifacts 表落库;缺 path/相对路径 → 静默跳过
  // 字符串结果(file_write 风格 "已写入 <abs>")也提取首个绝对路径,否则产物面板永远为空
  private maybeEmitArtifact(conversationId: number | undefined, output: unknown): void {
    let path: string | undefined
    let size = 0
    if (typeof output === 'object' && output !== null) {
      const rec = output as Record<string, unknown>
      if (typeof rec.path === 'string') {
        path = rec.path
        size = typeof rec.size === 'number' ? rec.size : 0
      }
    } else if (typeof output === 'string') {
      const m = output.match(/(^|\s)(\/[^\s]+)/)
      if (m) path = m[2]
    }
    if (typeof path !== 'string' || path === '') return
    if (!isAbsolute(path)) return
    const type = artifactType(path)
    this.deps.emit({ type: 'artifact', data: { path, type, size } })
    if (conversationId !== undefined) this.deps.store?.addArtifact?.({ conversationId, path, type, size })
  }
}

function approvalTarget(toolName: string, input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const rec = input as Record<string, unknown>
    const hit = rec.path ?? rec.target ?? rec.file ?? rec.title
    if (typeof hit === 'string') return hit
    // 无路径字段的工具(kb_upload 等):只给参数键名摘要,不把整个文档内容送进审批弹窗
    const keys = Object.keys(rec)
    return keys.length > 0 ? `(${keys.join(', ')})` : JSON.stringify(input)
  }
  return String(input)
}

// ---- 远程知识库工具(服务端 MCP 代理,会话凭证来自 session_cache) ----
// kb_upload 为数据外发口 → 标记高危,引擎审批门控兜底

export function createKbTools(session: Session): { tools: Record<string, Tool>; highRisk: string[] } {
  const tools: Record<string, Tool> = {
    kb_search: tool({
      description: '在企业知识库中按关键词搜索文档,返回标题/摘要/文档ID列表',
      inputSchema: z.object({
        query: z.string(),
        page: z.number().optional(),
        page_size: z.number().optional(),
      }),
      execute: ({ query, page, page_size }) => kbSearch(session, query, page, page_size),
    }),
    kb_read: tool({
      description: '按文档ID读取企业知识库中的文档正文',
      inputSchema: z.object({ doc_id: z.number() }),
      execute: ({ doc_id }) => kbRead(session, doc_id),
    }),
    kb_list: tool({
      description: '列出企业知识库目录结构(folder_id 为空时列根目录)',
      inputSchema: z.object({ folder_id: z.number().nullable().optional() }),
      execute: ({ folder_id }) => kbList(session, folder_id ?? null),
    }),
    kb_upload: tool({
      description: '将文本内容上传到企业知识库(数据外发至服务端,需用户确认)',
      inputSchema: z.object({
        title: z.string(),
        content: z.string(),
        folder_id: z.number().optional(),
      }),
      execute: ({ title, content, folder_id }) => kbUpload(session, title, content, folder_id ?? null),
    }),
  }
  return { tools, highRisk: ['kb_upload'] }
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
    // v7:成功结果 output 为原始值(字符串/对象),错误结果才是 { type:'text', value:'Error: ...' }
    const value =
      typeof part.output === 'string'
        ? part.output
        : part.output && typeof part.output === 'object' && 'value' in part.output
          ? part.output.type === 'text'
            ? part.output.value
            : JSON.stringify(part.output.value)
          : JSON.stringify(part.output)
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
