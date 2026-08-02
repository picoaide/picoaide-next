import { afterEach, describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import type { LanguageModel, ModelMessage } from 'ai'
import { AgentEngine, fromModelMessage, toModelMessage } from './engine'
import type { DBMessage } from './engine'
import type { AgentEvent } from './events'
import { createGatewayModel } from './provider'

class MockProvider {
  specificationVersion = 'v4' as const
  provider = 'mock'
  modelId = 'mock-model'
  script: 'text' | 'tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang'
  callCount = 0
  prompts: unknown[] = []

  constructor(script: 'text' | 'tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang' = 'text') {
    this.script = script
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
    if (this.hasToolResults(prompt)) return [{ type: 'text', text: 'final answer' }]
    if (this.script === 'tool-call')
      return [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'file_delete',
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
  const messages: Array<{ conversationId: number; role: string; content: string }> = []
  let nextId = 1
  const store = {
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
      messages.filter((m) => m.conversationId === conversationId),
    appendMessage: (input: { conversationId: number; role: string; content?: string }): number => {
      messages.push({ conversationId: input.conversationId, role: input.role, content: input.content ?? '' })
      return messages.length
    },
  }
  store.createConversation()
  return store
}

function makeEngine(
  script: 'text' | 'tool-call' | 'two-tool-calls' | 'throw' | 'throw-once' | 'throw-local' | 'hang',
  cfg: Partial<{ maxSteps: number; approvalTimeoutMs: number; retryCount: number }> = {},
  store: ReturnType<typeof makeStore> = makeStore(),
) {
  const mock = new MockProvider(script)
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
