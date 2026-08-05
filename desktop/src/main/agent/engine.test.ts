import { afterEach, describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import type { LanguageModel, ModelMessage, Tool } from 'ai'
import { AgentEngine, createKbTools, fromModelMessage, historyMessages, sanitizeMessages, toModelMessage } from './engine'
import type { AppendMessageInput, DBMessage } from './engine'
import type { AgentEvent } from './events'
import { createGatewayModel } from './provider'
import { ToolError } from '../tools/paths'
import type { GatedTool } from './engine'
import type { Session } from '../gateway/config'
import { kbSearch } from '../gateway/remote_mcp'

// AI SDK v7 在模型 doStream 抛错(测试故意制造的上游故障)时,内部 streamStep 的
// promise 链会泄漏一次 unhandled rejection(与引擎消费无关,见最小复现)。
// 这里仅吞掉 MockProvider 抛出的预期错误,不屏蔽其他真实异常。
const MOCK_ERRORS = new Set(['mock upstream failed', 'local fs error'])
const guard = (reason: unknown) => {
  if (reason instanceof Error && MOCK_ERRORS.has(reason.message)) return
  process.stderr.write(`[unhandledRejection] ${String(reason)}\n`)
}
process.on('unhandledRejection', guard)

vi.mock('../gateway/remote_mcp', () => ({
  kbSearch: vi.fn(async () => 'kb: found'),
  kbRead: vi.fn(async () => 'kb: doc body'),
  kbList: vi.fn(async () => 'kb: []'),
  kbUpload: vi.fn(async () => 'kb: uploaded'),
}))

class MockProvider {
  specificationVersion = 'v4' as const
  provider = 'mock'
  modelId = 'mock-model'
  script: 'text' | 'tool-call' | 'always-tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang' | 'approval-chain' | 'gated-tool'
  toolName: string
  toolInput: unknown
  callCount = 0
  prompts: unknown[] = []
  private gate: Promise<void> | null = null
  private gateResolve: (() => void) | null = null

  openGate(): void {
    this.gateResolve?.()
  }

  private waitGate(): Promise<void> {
    if (!this.gate) {
      this.gate = new Promise((resolve) => {
        this.gateResolve = resolve
      })
    }
    return this.gate
  }

  constructor(
    script: 'text' | 'tool-call' | 'always-tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang' | 'approval-chain' | 'gated-tool' = 'text',
    toolName = 'file_delete',
    toolInput: unknown = { path: '/home/u/x.doc' },
  ) {
    this.script = script
    this.toolName = toolName
    this.toolInput = toolInput
  }

  private hasToolResults(prompt: unknown): boolean {
    return (
      Array.isArray(prompt) &&
      prompt.some(
        (m) => typeof m === 'object' && m !== null && (m as { role?: string }).role === 'tool',
      )
    )
  }

  // 真实模型行为:prompt 里已有 assistant[tool-call](SDK 已执行/已处理)→ 输出最终文本;否则(首次)输出工具调用
  private hasPreviousToolCall(prompt: unknown): boolean {
    return (
      Array.isArray(prompt) &&
      prompt.some(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { role?: string }).role === 'assistant' &&
          Array.isArray((m as { content?: unknown }).content) &&
          ((m as { content: Array<{ type?: string }> }).content.some((p) => p?.type === 'tool-call') ||
            (m as { content: Array<{ type?: string }> }).content.some((p) => p?.type === 'text')),
      )
    )
  }

  private usage() {
    return {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    }
  }

  private contentFor(prompt: unknown) {
    if (this.script === 'gated-tool') {
      // call1:工具调用;call2:挂起等 gate(测试在挂起期间排队消息);call3:文本收尾
      if (this.callCount === 1) {
        return [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: this.toolName,
            input: JSON.stringify(this.toolInput),
          },
        ]
      }
      if (this.callCount === 2) {
        return [
          {
            type: 'tool-call',
            toolCallId: 'call_2',
            toolName: 'file_read',
            input: JSON.stringify({ path: '/b' }),
          },
        ]
      }
      return [{ type: 'text', text: 'final answer' }]
    }
    if (this.script === 'approval-chain') {
      // call1:需审批的工具;call2(审批执行轮,模型被再次调用):发免审批工具;call3:文本收尾
      if (this.callCount === 1) {
        return [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: this.toolName,
            input: JSON.stringify(this.toolInput),
          },
        ]
      }
      if (this.callCount === 2) {
        return [
          {
            type: 'tool-call',
            toolCallId: 'call_2',
            toolName: 'file_read',
            input: JSON.stringify({ path: '/b' }),
          },
        ]
      }
      return [{ type: 'text', text: 'final answer' }]
    }
    // 已有工具调用历史(已执行/已处理)或工具结果消息 → 模型收尾输出文本;否则首次输出工具调用
    if (this.script !== 'always-tool-call' && (this.hasToolResults(prompt) || this.hasPreviousToolCall(prompt)))
      return [{ type: 'text', text: 'final answer' }]
    if (this.script === 'tool-call' || this.script === 'always-tool-call')
      return [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: this.toolName,
          input: JSON.stringify(this.toolInput),
        },
      ]
    if (this.script === 'two-tool-calls')
      return [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'file_delete',
          input: JSON.stringify({ path: '/a' }),
        },
        {
          type: 'tool-call',
          toolCallId: 'call_2',
          toolName: 'file_wipe',
          input: JSON.stringify({ path: '/b' }),
        },
      ]
    return [{ type: 'text', text: 'hello world' }]
  }

  private finishReasonFor(content: Array<{ type: string }>) {
    return { unified: content.some((p) => p.type === 'tool-call') ? ('tool-calls' as const) : ('stop' as const), raw: undefined }
  }

  async doGenerate(options: any) {
    if (this.script === 'throw') throw new Error('mock upstream failed')
    this.callCount++
    this.prompts.push(options.prompt)
    const content = this.contentFor(options.prompt)
    return {
      content,
      finishReason: this.finishReasonFor(content),
      usage: this.usage(),
      warnings: [],
    }
  }

  async doStream(options: any) {
    this.callCount++
    this.prompts.push(options.prompt)
    if (this.script === 'gated-tool' && this.callCount === 2) await this.waitGate()
    if (this.script === 'throw') throw new Error('mock upstream failed')
    if (this.script === 'throw-once' && this.callCount === 1) throw new Error('mock upstream failed')
    if (this.script === 'throw-local') throw new Error('local fs error')
    if (this.script === 'hang') {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 't1' })
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'hello' })
          },
        }),
      }
    }
    const content = this.contentFor(options.prompt)
    const parts: any[] = content
      .filter((p: any) => p.type === 'tool-call')
      .map((p: any) => ({ type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: p.input }))
    if (parts.length === 0) {
      parts.unshift({ type: 'text-start', id: 't1' })
      parts.push({ type: 'text-delta', id: 't1', delta: 'hello world' })
      parts.push({ type: 'text-end', id: 't1' })
    }
    parts.push({ type: 'finish', usage: this.usage(), finishReason: this.finishReasonFor(content) })
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      }),
    }
  }
}

// 内存版 StoreLike:默认建好 id=1 的会话;测试可覆写方法制造"会话被删"等场景
function makeStore() {
  const conversations = new Map<number, { id: number; status: string }>()
  const messages: Array<AppendMessageInput & { id: number }> = []
  const artifacts: Array<{ conversationId: number; path: string; type: string; size: number }> = []
  let nextId = 1
  const store = {
    artifacts,
    createConversation: (): number => {
      const id = nextId++
      conversations.set(id, { id, status: 'done' })
      return id
    },
    getConversation: (id: number) => conversations.get(id) ?? null,
    updateConversationStatus: (id: number, status: string): void => {
      const c = conversations.get(id)
      if (c) c.status = status
    },
    deleteConversation: (id: number): void => {
      conversations.delete(id)
    },
    listMessages: (conversationId: number): DBMessage[] =>
      (messages.filter((m) => m.conversationId === conversationId) as unknown as DBMessage[]),
    appendMessage: (input: AppendMessageInput): number => {
      // 镜像真实 store:AppendMessageInput → DBMessage(列名转换)
      const row: DBMessage = {
        role: input.role,
        content: input.content ?? '',
        reasoning: input.reasoning ?? '',
        tool_calls: input.toolCalls ?? '[]',
        tool_call_id: input.toolCallId ?? '',
        tool_name: input.toolName ?? '',
        is_error: input.isError ? 1 : 0,
      }
      messages.push({ ...row, id: messages.length + 1, conversationId: input.conversationId } as AppendMessageInput & { id: number })
      return messages.length
    },
    addArtifact: (a: { conversationId: number; path: string; type: string; size: number }): number => {
      artifacts.push(a)
      return artifacts.length
    },
  }
  store.createConversation()
  return store
}

function makeEngine(
  script: 'text' | 'tool-call' | 'always-tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang' | 'approval-chain' | 'gated-tool',
  cfg: Partial<{ maxSteps: number; approvalTimeoutMs: number; retryCount: number; fetch: typeof fetch }> = {},
  store: ReturnType<typeof makeStore> = makeStore(),
  toolName = 'file_delete',
  toolInput: unknown = { path: '/home/u/x.doc' },
) {
  const mock = new MockProvider(script, toolName, toolInput)
  const events: AgentEvent[] = []
  const engine = new AgentEngine(
    { model: mock as unknown as LanguageModel, sysPrompt: 'sys', ...cfg },
    { emit: (ev) => events.push(ev), store },
  )
  return { mock, events, engine, store }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function flushMicrotasks(times = 200): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

// 事件契约 v2:引擎自动附加 conversationId(专项测试验证归属),常规断言剥离该字段
function eventsOf(events: AgentEvent[], type: string) {
  return events
    .filter((e) => e.type === type)
    .map((e) => {
      const { conversationId: _c, ...rest } = e
      return rest as AgentEvent
    })
}

const fileRead = tool({
  description: 'read a file',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => `contents of ${path}`,
})

const deletedPaths: string[] = []
const fileDelete = tool({
  description: 'delete a file',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    deletedPaths.push(path)
    return 'deleted'
  },
})

const wipedPaths: string[] = []
const fileWipe = tool({
  description: 'wipe a file',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    wipedPaths.push(path)
    return 'wiped'
  },
})

const tools = { file_read: fileRead, file_delete: fileDelete, file_wipe: fileWipe }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  deletedPaths.length = 0
  wipedPaths.length = 0
})

describe('provider', () => {
  it('createGatewayModel builds an openai-compatible chat model for the gateway', () => {
    const model = createGatewayModel('https://gw.example.com', 'tok-123', 'deepseek-chat')
    expect(model.modelId).toBe('deepseek-chat')
    expect(model.provider).toBe('gateway.chat')
  })
})

describe('AgentEngine ask mode', () => {
  it('streams text_delta, persists user+assistant messages, and finishes with usage', async () => {
    const { mock, events, engine, store } = makeEngine('text')
    await engine.ask({ conversationId: 1, content: 'hello' })
    expect(eventsOf(events, 'text_delta').map((e) => e.data)).toEqual(['hello world'])
    const done = eventsOf(events, 'done')[0]
    expect(done).toEqual({ type: 'done', data: { usage: { prompt_tokens: 10, completion_tokens: 5 } } })
    expect(mock.callCount).toBe(1)
    const msgs = store.listMessages(1)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toBe('hello world')
    expect(store.getConversation(1)?.status).toBe('done')
  })

  it('sends only the last 50 history messages to the model', async () => {
    const store = makeStore()
    for (let i = 0; i < 55; i++) {
      store.appendMessage({ conversationId: 1, role: 'user', content: `m${i}` })
    }
    const { mock, engine } = makeEngine('text', {}, store)
    await engine.ask({ conversationId: 1, content: 'hi' })
    const prompt = mock.prompts[0] as Array<{ role: string; content: unknown }>
    expect(prompt).toHaveLength(52) // system + 50 条历史 + 本条 user
    expect(prompt[0].role).toBe('system')
    expect((prompt[1].content as Array<{ text: string }>)[0].text).toBe('m5')
    expect((prompt.at(-1)?.content as Array<{ text: string }>)[0].text).toBe('hi')
  })

  it('marks the conversation running then failed and emits error when the model fails', async () => {
    const { events, engine, store } = makeEngine('throw')
    await expect(engine.ask({ conversationId: 1, content: 'hello' })).rejects.toThrow('mock upstream failed')
    expect(eventsOf(events, 'error')).toHaveLength(1)
    expect(store.getConversation(1)?.status).toBe('failed')
  })

  it('retries once on an upstream 5xx-class error and succeeds', async () => {
    const { mock, events, engine, store } = makeEngine('throw-once')
    await engine.ask({ conversationId: 1, content: 'hello' })
    expect(mock.callCount).toBe(2)
    expect(eventsOf(events, 'error')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
    const msgs = store.listMessages(1)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toBe('hello world')
  })

  it('does not retry non-5xx errors', async () => {
    const { mock, engine } = makeEngine('throw-local', { retryCount: 5 })
    await expect(engine.ask({ conversationId: 1, content: 'hello' })).rejects.toThrow('local fs error')
    expect(mock.callCount).toBe(1)
  })

  it('craft retries a step whose stream failed before producing any output', async () => {
    const { mock, events, engine, store } = makeEngine('throw-once', { retryCount: 1 })
    await engine.craft({ conversationId: 1, content: 'hello', tools: {}, highRiskTools: new Set() })
    // 首次调用上游抛错(流未开始)→ 重试 1 次成功
    expect(mock.callCount).toBe(2)
    expect(eventsOf(events, 'error')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(store.listMessages(1).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('craft does not retry a step that already executed tools (side effects)', async () => {
    const { mock, engine } = makeEngine('throw-local', { retryCount: 5 })
    await expect(
      engine.craft({ conversationId: 1, content: 'delete it', tools: { file_delete: fileDelete }, highRiskTools: new Set() }),
    ).rejects.toThrow('local fs error')
    // 工具执行期间失败:重试会重复副作用,必须直接失败
    expect(mock.callCount).toBe(1)
  })

  it('craft accepts a per-call sysPrompt override', async () => {
    const { engine, mock } = makeEngine('text')
    await engine.craft({ conversationId: 1, content: 'hello', tools: {}, highRiskTools: new Set(), sysPrompt: 'sys-override' })
    const system = mock.prompts.at(-1) as Array<{ role: string; content: string }>
    expect(system[0].role).toBe('system')
    expect(system[0].content).toBe('sys-override')
  })

  it('approvePlan passes a sysPrompt override into the execution round', async () => {
    const { engine, mock } = makeEngine('text')
    await engine.plan({ conversationId: 1, content: '写一份周报' })
    await engine.approvePlan({ conversationId: 1, ok: true, tools: {}, highRiskTools: new Set(), sysPrompt: 'exec-override' })
    const system = mock.prompts.at(-1) as Array<{ role: string; content: string }>
    expect(system[0].role).toBe('system')
    expect(system[0].content).toContain('exec-override')
  })

  it('queueMessage rejects during ask (single-step has no dequeue point)', async () => {
    const { engine, store } = makeEngine('text')
    const run = engine.ask({ conversationId: 1, content: 'hello' })
    // 等 ask 进入运行态(落库 user 行)
    await waitFor(() => store.listMessages(1).length > 0)
    expect(engine.queueMessage(1, 'queued?')).toBe(false)
    await run
    expect(store.listMessages(1).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('skips DB writes and stays graceful when the conversation is deleted mid-run', async () => {
    const store = makeStore()
    store.updateConversationStatus = (id, status) => {
      if (status === 'running') store.deleteConversation(id)
    }
    const { events, engine } = makeEngine('text', {}, store)
    await engine.ask({ conversationId: 1, content: 'hello' })
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(store.listMessages(1).filter((m) => m.role === 'assistant')).toEqual([])
  })

  it('cancel mid-stream emits canceled and marks the conversation failed', async () => {
    const { events, engine, store } = makeEngine('hang')
    const run = engine.ask({ conversationId: 1, content: 'hello' })
    await waitFor(() => eventsOf(events, 'text_delta').length > 0)
    engine.cancel()
    await run
    expect(eventsOf(events, 'canceled')).toEqual([{ type: 'canceled', data: { reason: 'user_canceled' } }])
    expect(store.getConversation(1)?.status).toBe('failed')
  })
})

describe('AgentEngine craft loop', () => {
  it('runs tool calls, feeds results back, and finishes', async () => {
    const { mock, events, engine } = makeEngine('tool-call')
    const run = engine.craft({
      conversationId: 1,
      content: 'delete the file',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const req = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(req.data.request_id, true)
    await run
    expect(eventsOf(events, 'tool_start')).toHaveLength(1)
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(mock.callCount).toBe(2)
    const secondPrompt = mock.prompts[1] as Array<{ role: string }>
    expect(secondPrompt.some((m) => m.role === 'tool')).toBe(true)
  })

  it('stops the loop when maxSteps is reached without feeding tool results back', async () => {
    const { mock, events, engine } = makeEngine('tool-call', { maxSteps: 1 })
    const run = engine.craft({
      conversationId: 1,
      content: 'delete the file',
      tools,
      highRiskTools: new Set(),
    })
    await run
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    expect(mock.callCount).toBe(1)
    // 步数满且最后一轮仍在调工具:工具已执行但结果未回传 → 超限
    expect(eventsOf(events, 'error')).toEqual([{ type: 'error', data: '达到最大步骤数' }])
    expect(eventsOf(events, 'done')).toHaveLength(0)
  })
})

const writeReport = tool({
  description: 'write a report file',
  inputSchema: z.object({ path: z.string() }),
  execute: async () => ({ path: '/workspace/report.md', size: 10 }),
})

const noPathTool = tool({
  description: 'returns a result without a path',
  inputSchema: z.object({}),
  execute: async () => ({ size: 5 }),
})

const stringPathTool = tool({
  description: 'returns a message containing an absolute path (file_write style)',
  inputSchema: z.object({}),
  execute: async () => '已写入 /workspace/notes.md',
})

describe('AgentEngine craft (store-backed)', () => {
  it('runs tool calls across steps, persists assistant+tool rows, and finishes', async () => {
    const { mock, events, engine, store } = makeEngine('tool-call', {}, makeStore(), 'file_read')
    await engine.craft({ conversationId: 1, content: 'read the file', tools, highRiskTools: new Set() })
    expect(mock.callCount).toBe(2)
    expect(eventsOf(events, 'tool_start')).toHaveLength(1)
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    const msgs = store.listMessages(1)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const toolRow = msgs.find((m) => m.role === 'tool')
    expect(toolRow).toMatchObject({
      content: 'contents of /home/u/x.doc',
      tool_call_id: 'call_1',
      tool_name: 'file_read',
      is_error: 0,
    })
    expect(store.getConversation(1)?.status).toBe('done')
    const done = eventsOf(events, 'done')[0]
    // totalUsage 累计整个多步 run(两轮 10/5)
    expect(done).toEqual({ type: 'done', data: { usage: { prompt_tokens: 20, completion_tokens: 10 } } })
  })

  it('marks the conversation running before starting and persists the user message', async () => {
    const { engine, store } = makeEngine('text')
    let sawRunning = false
    store.updateConversationStatus = (id, status) => {
      if (status === 'running') sawRunning = true
    }
    await engine.craft({ conversationId: 1, content: 'hello', tools: {}, highRiskTools: new Set() })
    expect(sawRunning).toBe(true)
    expect(store.listMessages(1).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('emits 达到最大步骤数 error and marks failed when the model keeps calling tools', async () => {
    const { mock, events, engine, store } = makeEngine('always-tool-call', { maxSteps: 2 }, makeStore(), 'file_read')
    await engine.craft({ conversationId: 1, content: 'keep going', tools, highRiskTools: new Set() })
    expect(mock.callCount).toBe(2)
    expect(eventsOf(events, 'error')).toEqual([{ type: 'error', data: '达到最大步骤数' }])
    expect(eventsOf(events, 'done')).toHaveLength(0)
    expect(store.getConversation(1)?.status).toBe('failed')
  })

  it('queueMessage enqueues to the running conversation and the next step consumes it', async () => {
    const { mock, events, engine, store } = makeEngine('gated-tool', { maxSteps: 5 }, makeStore(), 'file_read')
    const run = engine.craft({ conversationId: 1, content: '任务一', tools, highRiskTools: new Set() })
    // 第二轮模型调用挂起(gate),引擎保持运行:排队接受,立即落库 user 行
    await waitFor(() => mock.callCount >= 2)
    expect(engine.queueMessage(1, '排队消息')).toBe(true)
    expect(store.listMessages(1).some((m) => m.role === 'user' && m.content === '排队消息')).toBe(true)
    mock.openGate()
    await run
    // 排队消息已作为 user 消息推进到下一轮模型调用(第三轮 prompt)
    const prompts = mock.prompts.map((p) => JSON.stringify(p))
    expect(prompts[2]?.includes('排队消息')).toBe(true)
    expect(eventsOf(events, 'done')).toHaveLength(1)
  })

  it('queueMessage rejects when not running, on another conversation, or after cancel', async () => {
    const { mock, events, engine, store } = makeEngine('gated-tool', { maxSteps: 5 }, makeStore(), 'file_read')
    // 未运行:拒绝
    expect(engine.queueMessage(1, 'x')).toBe(false)
    const run = engine.craft({ conversationId: 1, content: '任务一', tools, highRiskTools: new Set() })
    await waitFor(() => mock.callCount >= 2)
    // 会话不匹配:拒绝
    expect(engine.queueMessage(999, 'x')).toBe(false)
    // 取消后:拒绝(队列清空)
    engine.cancel()
    await run
    expect(engine.queueMessage(1, 'x')).toBe(false)
  })

  it('deny skips the tool (SDK tool-output-denied) and lets the agent finish', async () => {
    const { mock, events, engine, store } = makeEngine('tool-call')
    const run = engine.craft({ conversationId: 1, content: 'delete it', tools, highRiskTools: new Set(['file_delete']) })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const req0 = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(req0.data.request_id, false)
    await run
    expect(deletedPaths).toEqual([])
    expect(mock.callCount).toBe(2)
    // SDK 原生审批:拒绝 = 工具不执行(无 tool-error),denial 回传模型后模型收尾;
    // 但必须落一条 is_error tool 行,保证 DB 历史 tool_call 有配对结果(重跑不 MissingToolResultsError)
    const denied = store.listMessages(1).filter((m) => m.role === 'tool')
    expect(denied).toHaveLength(1)
    expect(denied[0].is_error).toBe(1)
    expect(denied[0].tool_name).toBe("file_delete")
    expect(eventsOf(events, 'tool_start')).toHaveLength(0)
    expect(eventsOf(events, 'tool_error')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(store.getConversation(1)?.status).toBe('done')
  })

  it('deny persists a tool row so later messages do not fail with MissingToolResultsError', async () => {
    const { events, engine, store } = makeEngine('tool-call')
    const run = engine.craft({ conversationId: 1, content: 'delete it', tools, highRiskTools: new Set(['file_delete']) })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const req0 = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(req0.data.request_id, false)
    await run
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(store.listMessages(1).filter((m) => m.role === 'tool')).toHaveLength(1)
    // 拒绝后再次 craft,模型继续调用工具:历史必须完整,否则 SDK 抛 MissingToolResultsError
    const second = makeEngine('tool-call', {}, store, 'file_read')
    await second.engine.craft({ conversationId: 1, content: 'read it', tools, highRiskTools: new Set() })
    expect(eventsOf(second.events, 'error')).toHaveLength(0)
    expect(eventsOf(second.events, 'done')).toHaveLength(1)
  })

  it('cancel mid-craft emits canceled and marks the conversation failed', async () => {
    const { events, engine, store } = makeEngine('hang')
    const run = engine.craft({ conversationId: 1, content: 'hello', tools: {}, highRiskTools: new Set() })
    await waitFor(() => eventsOf(events, 'text_delta').length > 0)
    engine.cancel()
    await run
    expect(eventsOf(events, 'canceled')).toEqual([{ type: 'canceled', data: { reason: 'user_canceled' } }])
    expect(store.getConversation(1)?.status).toBe('failed')
  })

  it('skips DB writes when the conversation is deleted mid-run', async () => {
    const store = makeStore()
    store.updateConversationStatus = (id, status) => {
      if (status === 'running') store.deleteConversation(id)
    }
    const { events, engine } = makeEngine('tool-call', {}, store, 'file_read')
    await engine.craft({ conversationId: 1, content: 'read it', tools, highRiskTools: new Set() })
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(store.listMessages(1).filter((m) => m.role !== 'user')).toEqual([])
  })

  it('emits artifact events and persists rows for absolute-path results', async () => {
    const { events, engine, store } = makeEngine('tool-call', {}, makeStore(), 'write_report')
    await engine.craft({
      conversationId: 1,
      content: 'write it',
      tools: { write_report: writeReport },
      highRiskTools: new Set(),
    })
    expect(eventsOf(events, 'artifact')).toEqual([
      { type: 'artifact', data: { path: '/workspace/report.md', type: 'report', size: 10 } },
    ])
    expect(store.artifacts).toEqual([{ conversationId: 1, path: '/workspace/report.md', type: 'report', size: 10 }])
  })

  it('skips artifact registration when the result has no path', async () => {
    const { events, engine } = makeEngine('tool-call', {}, makeStore(), 'no_path')
    await engine.craft({ conversationId: 1, content: 'go', tools: { no_path: noPathTool }, highRiskTools: new Set() })
    expect(eventsOf(events, 'artifact')).toHaveLength(0)
  })

  it('registers artifacts from string results containing an absolute path (file_write style)', async () => {
    const { events, engine, store } = makeEngine('tool-call', {}, makeStore(), 'write_note')
    await engine.craft({
      conversationId: 1,
      content: 'write it',
      tools: { write_note: stringPathTool },
      highRiskTools: new Set(),
    })
    expect(eventsOf(events, 'artifact')).toEqual([
      { type: 'artifact', data: { path: '/workspace/notes.md', type: 'report', size: 0 } },
    ])
    expect(store.artifacts).toEqual([{ conversationId: 1, path: '/workspace/notes.md', type: 'report', size: 0 }])
  })

  it('does not register relative paths as artifacts', async () => {
    const relPath = tool({
      description: 'returns a relative path',
      inputSchema: z.object({}),
      execute: async () => ({ path: 'relative/report.md', size: 3 }),
    })
    const { events, engine } = makeEngine('tool-call', {}, makeStore(), 'rel_path')
    await engine.craft({ conversationId: 1, content: 'go', tools: { rel_path: relPath }, highRiskTools: new Set() })
    expect(eventsOf(events, 'artifact')).toHaveLength(0)
  })

  it('approval execution round followed by a new tool call never throws MissingToolResultsError', async () => {
    // 回归:审批批准后,执行轮模型继续调用免审批工具 → 结果跨轮回传。
    // 历史曾在此抛 MissingToolResultsError(SDK convert 要求 tool-call 后紧跟配对结果)。
    const { events, engine, store, mock } = makeEngine('approval-chain')
    const run = engine.craft({ conversationId: 1, content: 'delete then read', tools, highRiskTools: new Set(['file_delete']) })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const req = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(req.data.request_id, true)
    await run
    expect(eventsOf(events, 'error')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(deletedPaths).toEqual(['/home/u/x.doc'])
    expect(mock.callCount).toBe(3)
    // DB 顺序:assistant(审批) → tool(结果跨轮先落) → assistant(新调用) → tool(结果) → assistant(收尾文本)
    const rows = store.listMessages(1).filter((m) => m.role !== 'user')
    expect(rows.map((r) => r.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant'])
  })

  it('gates tools via a per-tool requiresApproval predicate even without highRiskTools', async () => {
    const gated = { ...fileDelete, requiresApproval: () => true } as Tool & { requiresApproval?: () => boolean }
    const { events, engine } = makeEngine('tool-call')
    const run = engine.craft({
      conversationId: 1,
      content: 'delete it',
      tools: { file_delete: gated },
      highRiskTools: new Set(),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const req0 = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(req0.data.request_id, true)
    await run
    expect(deletedPaths).toEqual(['/home/u/x.doc'])
  })
})

describe('AgentEngine plan mode', () => {
  it('plan round streams text, persists the plan, and leaves the conversation planning', async () => {
    const { mock, events, engine, store } = makeEngine('text')
    await engine.plan({ conversationId: 1, content: '写一份周报' })
    expect(mock.callCount).toBe(1)
    expect(eventsOf(events, 'tool_start')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(store.listMessages(1).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(store.listMessages(1)[1].content).toBe('hello world')
    expect(store.getConversation(1)?.status).toBe('planning')
  })

  it('plan mode runs read-only tools (file_read) to investigate before planning', async () => {
    const { events, engine, store } = makeEngine('tool-call', {}, makeStore(), 'file_read')
    await engine.plan({ conversationId: 1, content: '分析一下', tools, highRiskTools: new Set(['file_delete']) })
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    expect(eventsOf(events, 'confirm_required')).toHaveLength(0)
    expect(store.getConversation(1)?.status).toBe('planning')
  })

  it('plan mode drops write tools: a write-tool call is rejected without executing', async () => {
    const { events, engine, store } = makeEngine('tool-call', {}, makeStore(), 'file_delete')
    await engine.plan({ conversationId: 1, content: '分析', tools, highRiskTools: new Set(['file_delete']) })
    // 写工具被过滤:SDK 回传 tool-error,模型感知后收尾;工具本身绝不执行
    expect(deletedPaths).toEqual([])
    const errRows = store.listMessages(1).filter((m) => m.role === 'tool' && m.is_error === 1)
    expect(errRows).toHaveLength(1)
    expect(store.getConversation(1)?.status).toBe('planning')
  })

  it('approvePlan(true) runs the second round with tools and finishes done', async () => {
    const { mock, events, engine, store } = makeEngine('text')
    await engine.plan({ conversationId: 1, content: '读取并总结' })
    mock.script = 'tool-call'
    await engine.approvePlan({ conversationId: 1, ok: true, tools, highRiskTools: new Set() })
    expect(eventsOf(events, 'tool_start')).toHaveLength(1)
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    expect(deletedPaths).toEqual(['/home/u/x.doc'])
    expect(store.getConversation(1)?.status).toBe('done')
    expect(eventsOf(events, 'done')).toHaveLength(2) // plan 轮 + 执行轮
    // 执行轮上下文截断到最后一条 user 消息(计划文本不进入上下文,user 不重复)
    const execPrompt = mock.prompts[1] as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(execPrompt)).not.toContain('hello world')
    expect(execPrompt.some((m) => m.role === 'tool')).toBe(false)
    expect(store.listMessages(1).filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('approvePlan(false) marks the conversation rejected without executing', async () => {
    const { mock, events, engine, store } = makeEngine('text')
    await engine.plan({ conversationId: 1, content: '写周报' })
    mock.script = 'tool-call'
    await engine.approvePlan({ conversationId: 1, ok: false, tools, highRiskTools: new Set() })
    expect(store.getConversation(1)?.status).toBe('rejected')
    expect(mock.callCount).toBe(1)
    expect(eventsOf(events, 'tool_start')).toHaveLength(0)
  })

  it('marks the conversation failed when the plan round errors', async () => {
    const { events, engine, store } = makeEngine('throw')
    await expect(engine.plan({ conversationId: 1, content: 'hi' })).rejects.toThrow('mock upstream failed')
    expect(store.getConversation(1)?.status).toBe('failed')
  })

  it('approvePlan is a no-op when the conversation is not planning', async () => {
    const { mock, engine, store } = makeEngine('text')
    store.updateConversationStatus(1, 'done')
    mock.script = 'tool-call'
    await engine.approvePlan({ conversationId: 1, ok: true, tools, highRiskTools: new Set() })
    expect(mock.callCount).toBe(0)
    expect(store.getConversation(1)?.status).toBe('done')
  })
})

describe('AgentEngine continueConversation', () => {
  it('refuses to continue a conversation that is not resumable', async () => {
    const { engine, store } = makeEngine('text')
    store.appendMessage({ conversationId: 1, role: 'user', content: 'hi' })
    await expect(engine.continueConversation({ conversationId: 1 })).rejects.toThrow(/not resumable/)
  })

  it('resumes a failed conversation from its last user message with tools', async () => {
    const store = makeStore()
    store.updateConversationStatus(1, 'failed')
    store.appendMessage({ conversationId: 1, role: 'user', content: '写报告' })
    store.appendMessage({ conversationId: 1, role: 'assistant', content: '部分输出' })
    const { mock, events, engine } = makeEngine('tool-call', {}, store, 'file_read')
    await engine.continueConversation({ conversationId: 1, tools, highRiskTools: new Set() })
    expect(eventsOf(events, 'tool_start')).toHaveLength(1)
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    expect(store.getConversation(1)?.status).toBe('done')
    expect(mock.callCount).toBe(2)
    // 上下文截断到最后一条 user('写报告'),不含中断时的部分输出
    const prompt = mock.prompts[0] as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(prompt)).not.toContain('部分输出')
  })

  it('sanitizeMessages strips orphan tool-calls but keeps matched ones', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'orphan', toolName: 'file_delete', input: '{}' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'paired', toolName: 'file_read', input: '{}' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'paired', toolName: 'file_read', output: { type: 'text', value: 'ok' } }] },
    ]
    const out = sanitizeMessages(msgs)
    const calls = out.filter((m) => m.role === 'assistant').flatMap((m) => m.content as Array<{ type: string; toolCallId: string }>)
    expect(calls.map((p) => p.toolCallId)).toEqual(['paired'])
  })

  it('sanitizeMessages keeps tool-calls when an approval response is present (SDK resume needs them)', () => {
    // 审批轮:assistant 带 tool-call + approval-request,response 带 approval-response → 该 tool-call 豁免(SDK 续跑)
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'file_delete', input: '{}' },
          { type: 'tool-approval-request', approvalId: 'aitxt-1', toolCallId: 'call_1' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'aitxt-1', approved: false, reason: 'denied' }] },
    ]
    const out = sanitizeMessages(msgs)
    const calls = out
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId: string }>)
      .filter((p) => p.type === 'tool-call')
    expect(calls.map((p) => p.toolCallId)).toEqual(['call_1'])
  })

  it('sanitizeMessages strips orphans even when an approval response is present (approval does not shield them)', () => {
    // 回归:审批场景 + 模型输出畸形/未执行工具调用(无配对结果)时,
    // 旧实现 hasApproval 一刀切跳过清洗 → 孤儿穿透到 SDK → MissingToolResultsError。
    // 豁免只应覆盖审批轮自己的 tool-call,其他孤儿照常剥离。
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'file_delete', input: '{}' },
          { type: 'tool-approval-request', approvalId: 'aitxt-1', toolCallId: 'call_1' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'aitxt-1', approved: true, reason: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'orphan_call', toolName: 'file_read', input: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: '继续' }] },
    ]
    const out = sanitizeMessages(msgs)
    const calls = out
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId: string }>)
      .filter((p) => p.type === 'tool-call')
      .map((p) => p.toolCallId)
    expect(calls).toEqual(['call_1'])
  })

  it('sanitizeMessages reorders stray tool results to sit right after their assistant tool-call', () => {
    // 旧版本(审批跨轮落库顺序错乱)产生的历史:assistant(tool-call) → assistant(文本) → tool(结果)
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'X', toolName: 'file_read', input: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: '中间文本' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'X', toolName: 'file_read', output: { type: 'text', value: 'ok' } }] },
    ]
    const out = sanitizeMessages(msgs)
    const kinds = out.map((m) => m.role)
    expect(kinds).toEqual(['user', 'assistant', 'tool', 'assistant'])
    // 审批响应不得被重排(续跑依赖)
    const appr: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'Y', toolName: 'file_delete', input: '{}' }] },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'aitxt-9', approved: true, reason: 'ok' }] },
    ]
    const out2 = sanitizeMessages(appr)
    expect(out2.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('historyMessages strips orphans from DB rows', () => {
    const rows: DBMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: JSON.stringify([{ tool_call_id: 'x1', tool_name: 'file_delete', args: {} }]) },
    ]
    const out = historyMessages(rows)
    expect(JSON.stringify(out)).not.toContain('x1')
  })

  it('sanitizeMessages does not orphan a later assistant when a multi-result tool message is reordered', () => {
    // 回归:一条 tool 消息含多个 assistant 的结果时,若被前面 assistant 的重排整条提前,
    // 后面 assistant 的配对被抢走 → SDK 抛 MissingToolResultsError。
    // 修复:重排前按 toolCallId 拆分多结果 tool 消息 + 位置镜像检查兜底。
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'A', toolName: 'file_delete', input: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: '中间' }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'A', toolName: 'file_delete', output: { type: 'text', value: 'ok' } },
          { type: 'tool-result', toolCallId: 'B', toolName: 'file_read', output: { type: 'text', value: 'ok' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'B', toolName: 'file_read', input: '{}' }] },
    ]
    const out = sanitizeMessages(msgs)
    const kinds = out.map((m) => m.role)
    expect(kinds).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    // B 的 tool-call 必须被剥离(其配对已在重排时随 A 提前),SDK 检查才会通过
    const calls = out
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId: string }>)
      .filter((p) => p.type === 'tool-call')
      .map((p) => p.toolCallId)
    expect(calls).toEqual(['A'])
  })

  it('sanitizeMessages strips tool-calls whose result only appears after a user message (SDK position check)', () => {
    // SDK convert 的检查语义:tool-call 到下一个 user 消息前必须有配对 result。
    // 位置镜像检查必须与之一致:result 在 user 之后的不算配对。
    const msgs: ModelMessage[] = [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'A', toolName: 'file_delete', input: '{}' }] },
      { role: 'user', content: '第二轮' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'A', toolName: 'file_delete', output: { type: 'text', value: 'ok' } }] },
    ]
    const out = sanitizeMessages(msgs)
    const calls = out
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId: string }>)
      .filter((p) => p.type === 'tool-call')
      .map((p) => p.toolCallId)
    expect(calls).toEqual([])
  })

  it('sanitizeMessages keeps pairs that straddle an assistant text message', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'A', toolName: 'file_read', input: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: '中间' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'A', toolName: 'file_read', output: { type: 'text', value: 'ok' } }] },
    ]
    const out = sanitizeMessages(msgs)
    const calls = out
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId: string }>)
      .filter((p) => p.type === 'tool-call')
      .map((p) => p.toolCallId)
    expect(calls).toEqual(['A'])
  })

  it('strips orphan tool_calls from history so the SDK never sees unmatched tool calls', async () => {    // 场景:审批轮落库 assistant(tool_calls) 后会话终止(取消/步数超限),tool 行永不落库 → 历史孤儿
    const store = makeStore()
    store.appendMessage({ conversationId: 1, role: 'user', content: '删除文件' })
    store.appendMessage({
      conversationId: 1,
      role: 'assistant',
      content: '',
      toolCalls: JSON.stringify([{ tool_call_id: 'orphan_1', tool_name: 'file_delete', args: { path: '/x' } }]),
    })
    const { events, engine } = makeEngine('text', {}, store)
    await engine.craft({ conversationId: 1, content: '继续', tools, highRiskTools: new Set() })
    expect(eventsOf(events, 'error')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
    // 配对的 tool_calls 必须保留
    store.appendMessage({ conversationId: 1, role: 'user', content: '写文件' })
    store.appendMessage({
      conversationId: 1,
      role: 'assistant',
      content: '',
      toolCalls: JSON.stringify([{ tool_call_id: 'paired_1', tool_name: 'file_write', args: { path: '/y' } }]),
    })
    store.appendMessage({ conversationId: 1, role: 'tool', content: 'done', toolCallId: 'paired_1', toolName: 'file_write' })
    const { engine: engine2, events: events2 } = makeEngine('text', {}, store)
    await engine2.craft({ conversationId: 1, content: '再来', tools, highRiskTools: new Set() })
    expect(eventsOf(events2, 'done')).toHaveLength(1)
  })

  it('emits an error when there is no user message to resume from', async () => {
    const store = makeStore()
    store.updateConversationStatus(1, 'running')
    const { events, engine } = makeEngine('text', {}, store)
    await expect(engine.continueConversation({ conversationId: 1 })).rejects.toThrow(/no user message/)
    expect(eventsOf(events, 'error')).toHaveLength(1)
  })
})

describe('knowledge base tools', () => {
  it('createKbTools registers kb_search and marks kb_upload high-risk', async () => {
    const session: Session = { serverURL: 'https://srv.example.com', username: 'u', token: 't' }
    const { tools, highRisk } = createKbTools(session)
    expect(tools.kb_search).toBeTruthy()
    expect(tools.kb_read).toBeTruthy()
    expect(tools.kb_list).toBeTruthy()
    expect(tools.kb_upload).toBeTruthy()
    expect(highRisk).toEqual(['kb_upload'])
    const out = await (tools.kb_search as Tool).execute!({ query: 'budget' }, {} as never)
    expect(out).toBe('kb: found')
    expect(kbSearch).toHaveBeenCalledWith(session, 'budget', undefined, undefined)
  })
})

describe('approval gate', () => {
  it('blocks execution until confirm(requestId, true)', async () => {
    const { events, engine } = makeEngine('tool-call')
    const run = engine.craft({
      conversationId: 1,
      content: 'delete it',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    expect(deletedPaths).toEqual([])
    const req = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string; tool_call_id: string } }
    expect(req).toEqual({
      type: 'confirm_required',
      data: {
        request_id: req.data.request_id,
        tool_call_id: req.data.tool_call_id,
        op: 'file_delete',
        target: '/home/u/x.doc',
        reason: expect.any(String),
      },
    })
    expect(req.data.request_id).toBeTruthy()
    engine.confirm(req.data.request_id, true)
    await run
    expect(deletedPaths).toEqual(['/home/u/x.doc'])
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
  })

  it('stores the tool result row immediately after its assistant tool-call row (approval spans rounds)', async () => {
    const { events, engine, store } = makeEngine('tool-call')
    const run = engine.craft({ conversationId: 1, content: 'delete it', tools, highRiskTools: new Set(['file_delete']) })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const req = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(req.data.request_id, true)
    await run
    const rows = store.listMessages(1)
    const callIdx = rows.findIndex((m) => m.role === 'assistant' && (m.tool_calls ?? '').includes('file_delete'))
    const toolIdx = rows.findIndex((m) => m.role === 'tool')
    expect(callIdx).toBeGreaterThanOrEqual(0)
    // SDK 要求 assistant(tool_calls) 后紧跟 tool 消息;审批跨轮时结果在下一轮回传,
    // 落库必须仍保持紧邻,否则下次加载历史报 MissingToolResultsError
    expect(toolIdx).toBe(callIdx + 1)
  })

  it('deny rejects the tool (SDK tool-output-denied) and feeds denial back to the model', async () => {
    const { mock, events, engine } = makeEngine('tool-call')
    const run = engine.craft({
      conversationId: 1,
      content: 'delete it',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const req0 = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(req0.data.request_id, false)
    await run
    expect(deletedPaths).toEqual([])
    // SDK 原生审批:拒绝 = 工具不执行,无 tool_error 事件;denial 消息回传模型后模型收尾
    expect(eventsOf(events, 'tool_error')).toHaveLength(0)
    const secondPrompt = mock.prompts[1] as Array<{ role: string; content: Array<{ type: string; isError?: boolean }> }>
    const toolMsg = secondPrompt.find((m) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect(eventsOf(events, 'done')).toHaveLength(1)
  })

  it('auto-denies after approvalTimeoutMs (no SDK tool timeout cuts the window)', async () => {
    vi.useFakeTimers()
    const { events, engine } = makeEngine('tool-call', { approvalTimeoutMs: 1000 })
    const run = engine.craft({
      conversationId: 1,
      content: 'delete it',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await flushMicrotasks()
    // 新机制:confirm_required 在轮末(SDK 审批请求)发出;fake timers 下多排几次微任务
    await vi.advanceTimersByTimeAsync(0)
    expect(eventsOf(events, 'confirm_required')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    await run
    expect(deletedPaths).toEqual([])
    // 超时 = 自动拒绝:工具不执行(无 tool_error),denial 回传模型收尾
    expect(eventsOf(events, 'tool_error')).toHaveLength(0)
    expect(eventsOf(events, 'tool_start')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
  })

  it('serializes confirmations when a step contains multiple high-risk tools', async () => {
    const { events, engine } = makeEngine('two-tool-calls')
    const run = engine.craft({
      conversationId: 1,
      content: 'delete everything',
      tools,
      highRiskTools: new Set(['file_delete', 'file_wipe']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const first = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    expect(first.data.request_id).toBeTruthy()
    await new Promise((r) => setTimeout(r, 20))
    expect(eventsOf(events, 'confirm_required')).toHaveLength(1)
    engine.confirm(first.data.request_id, true)
    await waitFor(() => eventsOf(events, 'confirm_required').length === 2)
    const second = eventsOf(events, 'confirm_required')[1] as { data: { request_id: string } }
    expect(second.data.request_id).not.toBe(first.data.request_id)
    engine.confirm(second.data.request_id, false)
    await run
    expect(deletedPaths).toEqual(['/a'])
    expect(wipedPaths).toEqual([])
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    // SDK 拒绝 = tool-output-denied,不产生 tool_error(非错误,是用户决定)
    expect(eventsOf(events, 'tool_error')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
  })

  it('cancel rejects pending approvals and emits canceled, leaving no leaks', async () => {
    const { mock, events, engine } = makeEngine('tool-call')
    const run = engine.craft({
      conversationId: 1,
      content: 'delete it',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    engine.cancel()
    await run
    expect(eventsOf(events, 'canceled')).toEqual([{ type: 'canceled', data: { reason: 'user_canceled' } }])
    expect(deletedPaths).toEqual([])
    // 同引擎未卡死:取消后仍可继续运行(挂起审批已结清、运行槽已释放)
    mock.script = 'text'
    await engine.craft({ conversationId: 1, content: 'still there?', tools, highRiskTools: new Set() })
    expect(eventsOf(events, 'done')).toHaveLength(1)
  })

  it('confirm() for an already-settled request is a no-op', async () => {
    const { events, engine } = makeEngine('tool-call')
    const run = engine.craft({
      conversationId: 1,
      content: 'delete it',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const reqA = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(reqA.data.request_id, false)
    engine.confirm(reqA.data.request_id, true)
    await run
    expect(deletedPaths).toEqual([])
    expect(eventsOf(events, 'tool_error')).toHaveLength(0)
    expect(eventsOf(events, 'done')).toHaveLength(1)
  })
})

describe('message conversion round trip', () => {
  it('user row round trips', () => {
    const row: DBMessage = { role: 'user', content: 'hi' }
    expect(toModelMessage(row)).toEqual({ role: 'user', content: 'hi' })
    expect(fromModelMessage(toModelMessage(row) as ModelMessage)).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('assistant tool_calls round trip via content parts', () => {
    const row: DBMessage = {
      role: 'assistant',
      content: 'plan',
      tool_calls: JSON.stringify([{ tool_call_id: 'call_1', tool_name: 'file_delete', args: { path: '/x' } }]),
    }
    const msg = toModelMessage(row)
    expect(msg).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'plan' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'file_delete', input: { path: '/x' } },
      ],
    })
    const back = fromModelMessage(msg as ModelMessage)
    expect(back.role).toBe('assistant')
    expect(back.tool_calls).toBe(
      JSON.stringify([{ tool_call_id: 'call_1', tool_name: 'file_delete', args: { path: '/x' } }]),
    )
  })

  it('tool result row round trips and preserves is_error via Error: prefix', () => {
    const row: DBMessage = {
      role: 'tool',
      content: 'boom',
      tool_call_id: 'call_1',
      tool_name: 'file_delete',
      is_error: 1,
    }
    const msg = toModelMessage(row)
    expect(msg).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'file_delete',
          output: { type: 'text', value: 'Error: boom' },
        },
      ],
    })
    const back = fromModelMessage(msg as ModelMessage)
    expect(back).toMatchObject({
      role: 'tool',
      content: 'boom',
      tool_call_id: 'call_1',
      tool_name: 'file_delete',
      is_error: 1,
    })
  })

  it('successful tool result round trips without is_error', () => {
    const row: DBMessage = { role: 'tool', content: 'ok', tool_call_id: 'call_2', tool_name: 'file_read' }
    const msg = toModelMessage(row)
    const back = fromModelMessage(msg as ModelMessage)
    expect(back).toMatchObject({ role: 'tool', content: 'ok', tool_call_id: 'call_2', tool_name: 'file_read', is_error: 0 })
  })
})

describe('越界引导(boundary guide)', () => {
  it('工具越界 → confirm_required(allow_dir) → 确认后加入目录并自动重试', async () => {
    const { mock, events, store } = makeEngine('tool-call', {}, makeStore(), 'file_read')
    const addedDirs: string[] = []
    const engine = new AgentEngine(
      { model: mock as unknown as LanguageModel, sysPrompt: 'x', approvalTimeoutMs: 5000 },
      { emit: (ev) => events.push(ev), store, addAllowedDir: (dir) => addedDirs.push(dir) },
    )
    const inner = vi.fn().mockRejectedValueOnce(new ToolError('路径不在允许目录内: /home/u/desktop'))
      .mockResolvedValueOnce('ok-after-retry')
    const t: GatedTool = { ...tool({ description: 't', inputSchema: z.object({}), execute: inner }), execute: inner }
    const run = engine.craft({ conversationId: 1, content: 'x', tools: { file_read: t }, highRiskTools: new Set() })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const confirm = eventsOf(events, 'confirm_required')[0]
    expect(confirm).toBeDefined()
    const d = (confirm as any).data
    expect(d.op).toBe('allow_dir')
    expect(d.target).toBe('/home/u/desktop')
    expect(d.reason).toContain('加入可访问目录')
    engine.confirm(d.request_id, true)
    await run
    expect(addedDirs).toEqual(['/home/u/desktop'])
    expect(inner).toHaveBeenCalledTimes(2)
  })

  it('拒绝 → 不加入目录,错误回传模型', async () => {
    const { mock, events, store } = makeEngine('tool-call', {}, makeStore(), 'file_read')
    const addedDirs: string[] = []
    const engine = new AgentEngine(
      { model: mock as unknown as LanguageModel, sysPrompt: 'x', approvalTimeoutMs: 5000 },
      { emit: (ev) => events.push(ev), store, addAllowedDir: (dir) => addedDirs.push(dir) },
    )
    const inner = vi.fn().mockRejectedValue(new ToolError('路径不在允许目录内: /etc/passwd'))
    const t: GatedTool = { ...tool({ description: 't', inputSchema: z.object({}), execute: inner }), execute: inner }
    const run = engine.craft({ conversationId: 1, content: 'x', tools: { file_read: t }, highRiskTools: new Set() })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const req = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string } }
    engine.confirm(req.data.request_id, false)
    await run
    expect(addedDirs).toEqual([])
    // 错误回传模型(拒绝不授权,也不吞掉越界错误)
    expect(eventsOf(events, 'tool_error')).toHaveLength(1)
  })
})

describe('browser bridge end-to-end', () => {
  it('runs browser_navigate through the approval gate against a real CDP bridge', async () => {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.on('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const methods: string[] = []
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { id: number; method: string }
        methods.push(msg.method)
        ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }))
      })
    })
    try {
      const { createBrowserTools } = await import('../tools/browser')
      const btools = createBrowserTools({ port })
      const { events, engine } = makeEngine('tool-call', {}, makeStore(), 'browser_navigate', { url: 'https://www.google.com' })
      const run = engine.craft({
        conversationId: 1,
        content: '用浏览器打开谷歌',
        tools: { browser_navigate: btools.browser_navigate as GatedTool },
        highRiskTools: new Set(['browser_navigate']),
      })
      await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
      const req = eventsOf(events, 'confirm_required')[0] as { data: { request_id: string; op: string } }
      expect(req.data.op).toBe('browser_navigate')
      engine.confirm(req.data.request_id, true)
      await run
      expect(methods).toContain('browser.navigate')
      expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    } finally {
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })
})
