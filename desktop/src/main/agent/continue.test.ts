import { describe, expect, it } from 'vitest'
import type { LanguageModel } from 'ai'
import { AgentEngine } from './engine'
import type { AppendMessageInput, DBMessage } from './engine'
import { continueConversation, lastUserMessageIndex } from './continue'
import type { AgentEvent } from './events'

// 简化文本 mock:只出文本、不调工具(继续重跑只验证上下文截断与状态流转)
class MockTextProvider {
  specificationVersion = 'v4' as const
  provider = 'mock'
  modelId = 'mock-model'
  callCount = 0
  prompts: unknown[] = []

  async doGenerate() {
    throw new Error('not used')
  }

  async doStream(options: any) {
    this.callCount++
    this.prompts.push(options.prompt)
    const parts: any[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'resumed answer' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        finishReason: { unified: 'stop', raw: undefined },
      },
    ]
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

function makeStore() {
  const conversations = new Map<number, { id: number; status: string }>()
  const messages: Array<AppendMessageInput & { id: number }> = []
  const store = {
    getConversation: (id: number) => conversations.get(id) ?? null,
    updateConversationStatus: (id: number, status: string): void => {
      const c = conversations.get(id)
      if (c) c.status = status
    },
    listMessages: (conversationId: number): DBMessage[] =>
      messages.filter((m) => m.conversationId === conversationId) as unknown as DBMessage[],
    appendMessage: (input: AppendMessageInput): number => {
      messages.push({ ...input, id: messages.length + 1 })
      return messages.length
    },
  }
  conversations.set(1, { id: 1, status: 'done' })
  return store
}

function makeEngine(store: ReturnType<typeof makeStore>) {
  const mock = new MockTextProvider()
  const events: AgentEvent[] = []
  const engine = new AgentEngine(
    { model: mock as unknown as LanguageModel, sysPrompt: 'sys' },
    { emit: (ev) => events.push(ev), store },
  )
  return { mock, events, engine, store }
}

describe('lastUserMessageIndex', () => {
  it('returns the index of the last user row', () => {
    const rows: DBMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]
    expect(lastUserMessageIndex(rows)).toBe(2)
  })

  it('returns -1 when there are no user rows', () => {
    expect(lastUserMessageIndex([])).toBe(-1)
    expect(lastUserMessageIndex([{ role: 'assistant', content: 'b' }])).toBe(-1)
  })
})

describe('continueConversation (resume)', () => {
  it('truncates context to the last user message, streams, and finishes done', async () => {
    const store = makeStore()
    store.appendMessage({ conversationId: 1, role: 'user', content: 'first' })
    store.appendMessage({
      conversationId: 1,
      role: 'assistant',
      content: 'call tool',
      toolCalls: JSON.stringify([{ tool_call_id: 'c1', tool_name: 'file_read', args: { path: '/a' } }]),
    })
    store.appendMessage({ conversationId: 1, role: 'tool', content: 'result', toolCallId: 'c1', toolName: 'file_read' })
    store.appendMessage({ conversationId: 1, role: 'user', content: 'second' })
    store.appendMessage({ conversationId: 1, role: 'assistant', content: 'stale partial' })
    store.updateConversationStatus(1, 'running')

    const { mock, events, engine } = makeEngine(store)
    await continueConversation(engine, 1)

    expect(store.getConversation(1)?.status).toBe('done')
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    // 上下文只到最后一条 user 消息:其后的 assistant 行不进入
    const prompt = mock.prompts[0] as Array<{ role: string; content: unknown }>
    const body = prompt.filter((m) => m.role !== 'system')
    expect(body.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(JSON.stringify(body[3])).toContain('second')
    expect(JSON.stringify(prompt)).not.toContain('stale partial')
    // 不重复追加 user 行
    expect(store.listMessages(1).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['first', 'second'])
  })
})
