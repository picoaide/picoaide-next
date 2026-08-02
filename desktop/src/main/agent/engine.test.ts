import { afterEach, describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import type { LanguageModel, ModelMessage, Tool } from 'ai'
import { AgentEngine, createKbTools, fromModelMessage, toModelMessage } from './engine'
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
  script: 'text' | 'tool-call' | 'always-tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang'
  toolName: string
  callCount = 0
  prompts: unknown[] = []

  constructor(
    script: 'text' | 'tool-call' | 'always-tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang' = 'text',
    toolName = 'file_delete',
  ) {
    this.script = script
    this.toolName = toolName
  }

  private hasToolResults(prompt: unknown): boolean {
    return (
      Array.isArray(prompt) &&
      prompt.some(
        (m) => typeof m === 'object' && m !== null && (m as { role?: string }).role === 'tool',
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
    if (this.hasToolResults(prompt) && this.script !== 'always-tool-call')
      return [{ type: 'text', text: 'final answer' }]
    if (this.script === 'tool-call' || this.script === 'always-tool-call')
      return [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: this.toolName,
          input: JSON.stringify({ path: '/home/u/x.doc' }),
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
      messages.push({ ...input, id: messages.length + 1 })
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
  script: 'text' | 'tool-call' | 'always-tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang',
  cfg: Partial<{ maxSteps: number; approvalTimeoutMs: number; retryCount: number }> = {},
  store: ReturnType<typeof makeStore> = makeStore(),
  toolName = 'file_delete',
) {
  const mock = new MockProvider(script, toolName)
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

function eventsOf(events: AgentEvent[], type: string) {
  return events.filter((e) => e.type === type)
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
  delete process.env['PICOAI_TEST_AUTO_APPROVE']
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
    const done = events.find((e) => e.type === 'done')
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
    const run = engine.run({
      content: 'delete the file',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    engine.confirm('call_1', true)
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
    const run = engine.run({
      content: 'delete the file',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    engine.confirm('call_1', true)
    await run
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    expect(mock.callCount).toBe(1)
    expect(eventsOf(events, 'done')).toHaveLength(1)
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
      toolCallId: 'call_1',
      toolName: 'file_read',
      isError: false,
    })
    expect(store.getConversation(1)?.status).toBe('done')
    const done = events.find((e) => e.type === 'done')
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

  it('persists a rejected tool as an is_error row and lets the agent retry', async () => {
    const { mock, events, engine, store } = makeEngine('tool-call')
    const run = engine.craft({ conversationId: 1, content: 'delete it', tools, highRiskTools: new Set(['file_delete']) })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    engine.confirm('call_1', false)
    await run
    expect(deletedPaths).toEqual([])
    expect(mock.callCount).toBe(2)
    const toolRow = store.listMessages(1).find((m) => m.role === 'tool')
    expect(toolRow).toMatchObject({ toolName: 'file_delete', isError: true })
    expect(eventsOf(events, 'tool_error')).toHaveLength(1)
    expect(eventsOf(events, 'done')).toHaveLength(1)
    expect(store.getConversation(1)?.status).toBe('done')
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

  it('PICOAI_TEST_AUTO_APPROVE=1 auto-approves without emitting confirm_required', async () => {
    process.env['PICOAI_TEST_AUTO_APPROVE'] = '1'
    const { events, engine } = makeEngine('tool-call')
    await engine.craft({ conversationId: 1, content: 'delete it', tools, highRiskTools: new Set(['file_delete']) })
    expect(eventsOf(events, 'confirm_required')).toHaveLength(0)
    expect(deletedPaths).toEqual(['/home/u/x.doc'])
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
  })

  it('PICOAI_TEST_AUTO_APPROVE=0 auto-rejects without emitting confirm_required', async () => {
    process.env['PICOAI_TEST_AUTO_APPROVE'] = '0'
    const { events, engine } = makeEngine('tool-call')
    await engine.craft({ conversationId: 1, content: 'delete it', tools, highRiskTools: new Set(['file_delete']) })
    expect(eventsOf(events, 'confirm_required')).toHaveLength(0)
    expect(deletedPaths).toEqual([])
    expect(eventsOf(events, 'tool_error')).toHaveLength(1)
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
    engine.confirm('call_1', true)
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
    const run = engine.run({
      content: 'delete it',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    expect(deletedPaths).toEqual([])
    const req = eventsOf(events, 'confirm_required')[0]
    expect(req).toEqual({
      type: 'confirm_required',
      data: { request_id: 'call_1', op: 'file_delete', target: '/home/u/x.doc', reason: expect.any(String) },
    })
    engine.confirm((req as { data: { request_id: string } }).data.request_id, true)
    await run
    expect(deletedPaths).toEqual(['/home/u/x.doc'])
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
  })

  it('deny rejects the tool with an error that is fed back to the model', async () => {
    const { mock, events, engine } = makeEngine('tool-call')
    const run = engine.run({
      content: 'delete it',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    engine.confirm('call_1', false)
    await run
    expect(deletedPaths).toEqual([])
    const err = eventsOf(events, 'tool_error')[0]
    expect(err).toEqual({ type: 'tool_error', data: { id: 'call_1', name: 'file_delete', error: expect.any(String) } })
    const secondPrompt = mock.prompts[1] as Array<{ role: string; content: Array<{ type: string; isError?: boolean }> }>
    const toolMsg = secondPrompt.find((m) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect(eventsOf(events, 'done')).toHaveLength(1)
  })

  it('auto-denies after approvalTimeoutMs (no SDK tool timeout cuts the window)', async () => {
    vi.useFakeTimers()
    const { events, engine } = makeEngine('tool-call', { approvalTimeoutMs: 1000 })
    const run = engine.run({
      content: 'delete it',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await flushMicrotasks()
    expect(eventsOf(events, 'confirm_required')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    await run
    expect(deletedPaths).toEqual([])
    expect((eventsOf(events, 'tool_error')[0] as { data: { error: string } }).data.error).toMatch(/超时|timeout/i)
  })

  it('serializes confirmations when a step contains multiple high-risk tools', async () => {
    const { events, engine } = makeEngine('two-tool-calls')
    const run = engine.run({
      content: 'delete everything',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete', 'file_wipe']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    const first = eventsOf(events, 'confirm_required')[0]
    expect((first as { data: { request_id: string } }).data.request_id).toBe('call_1')
    await new Promise((r) => setTimeout(r, 20))
    expect(eventsOf(events, 'confirm_required')).toHaveLength(1)
    engine.confirm('call_1', true)
    await waitFor(() => eventsOf(events, 'confirm_required').length === 2)
    const second = eventsOf(events, 'confirm_required')[1]
    expect((second as { data: { request_id: string } }).data.request_id).toBe('call_2')
    engine.confirm('call_2', false)
    await run
    expect(deletedPaths).toEqual(['/a'])
    expect(wipedPaths).toEqual([])
    expect(eventsOf(events, 'tool_end')).toHaveLength(1)
    expect(eventsOf(events, 'tool_error')).toHaveLength(1)
  })

  it('cancel rejects pending approvals and emits canceled, leaving no leaks', async () => {
    const { events, engine } = makeEngine('tool-call')
    const run = engine.run({
      content: 'delete it',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    engine.cancel()
    await run
    expect(eventsOf(events, 'canceled')).toEqual([{ type: 'canceled', data: { reason: 'user_canceled' } }])
    expect(engine.pendingApprovalCount).toBe(0)
    expect(deletedPaths).toEqual([])
    const again = engine.run({
      content: 'still there?',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 2)
    engine.confirm('call_1', true)
    await again
    expect(engine.pendingApprovalCount).toBe(0)
  })

  it('confirm() for an already-settled request is a no-op', async () => {
    const { events, engine } = makeEngine('tool-call')
    const run = engine.run({
      content: 'delete it',
      mode: 'craft',
      tools,
      highRiskTools: new Set(['file_delete']),
    })
    await waitFor(() => eventsOf(events, 'confirm_required').length === 1)
    engine.confirm('call_1', false)
    engine.confirm('call_1', true)
    await run
    expect(deletedPaths).toEqual([])
    expect(eventsOf(events, 'tool_error')).toHaveLength(1)
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
    const events: AgentEvent[] = []
    const addedDirs: string[] = []
    const engine = new AgentEngine(
      { model: {} as LanguageModel, sysPrompt: 'x', approvalTimeoutMs: 5000 },
      {
        emit: (ev) => events.push(ev),
        addAllowedDir: (dir) => addedDirs.push(dir),
      },
    )
    const inner = vi.fn().mockRejectedValueOnce(new ToolError('路径不在允许目录内: /home/u/desktop'))
      .mockResolvedValueOnce('ok-after-retry')
    const t: GatedTool = { ...tool({ description: 't', inputSchema: z.object({}), execute: inner }), execute: inner }
    const wrapped = engine.wrapToolForTest('file_read', t, false)
    const run = (wrapped as any).execute({}, { toolCallId: 'call-1' })
    await new Promise((r) => setTimeout(r, 10))
    const confirm = events.find((e) => e.type === 'confirm_required')
    expect(confirm).toBeDefined()
    const d = (confirm as any).data
    expect(d.op).toBe('allow_dir')
    expect(d.target).toBe('/home/u/desktop')
    expect(d.reason).toContain('加入可访问目录')
    engine.confirm('call-1', true)
    const out = await run
    expect(out).toBe('ok-after-retry')
    expect(addedDirs).toEqual(['/home/u/desktop'])
    expect(inner).toHaveBeenCalledTimes(2)
  })

  it('拒绝 → 不加入目录,错误回传模型', async () => {
    const events: AgentEvent[] = []
    const addedDirs: string[] = []
    const engine = new AgentEngine(
      { model: {} as LanguageModel, sysPrompt: 'x', approvalTimeoutMs: 5000 },
      { emit: (ev) => events.push(ev), addAllowedDir: (dir) => addedDirs.push(dir) },
    )
    const inner = vi.fn().mockRejectedValue(new ToolError('路径不在允许目录内: /etc/passwd'))
    const t: GatedTool = { ...tool({ description: 't', inputSchema: z.object({}), execute: inner }), execute: inner }
    const wrapped = engine.wrapToolForTest('file_read', t, false)
    const run = (wrapped as any).execute({}, { toolCallId: 'call-2' })
    await new Promise((r) => setTimeout(r, 10))
    engine.confirm('call-2', false)
    await expect(run).rejects.toThrow()
    expect(addedDirs).toEqual([])
  })
})
