import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../main/agent/events'
import { useChatStore } from './chat'
import { useConnectionStore } from './connection'

interface FakePicoaide {
  chatNew: ReturnType<typeof vi.fn>
  chatList: ReturnType<typeof vi.fn>
  chatAsk: ReturnType<typeof vi.fn>
  chatMessages: ReturnType<typeof vi.fn>
  chatDelete: ReturnType<typeof vi.fn>
  chatCancel: ReturnType<typeof vi.fn>
}

function makeFake() {
  const conversations: Record<string, any>[] = []
  const messages: Record<string, any>[] = []
  let nextId = 1
  const api: FakePicoaide = {
    chatNew: vi.fn(async (input?: { mode?: string }) => {
      const id = nextId++
      conversations.push({ id, title: '', mode: input?.mode ?? 'ask', status: 'done', model: '', workspace: '', created_at: '', updated_at: '' })
      return id
    }),
    chatList: vi.fn(async () => conversations.map((c) => ({ ...c }))),
    chatAsk: vi.fn(async (cid: number, content: string) => {
      // 镜像引擎行为:ask 结束前把 user + assistant 都落库
      messages.push({ id: nextId++, conversation_id: cid, role: 'user', content, reasoning: '', tool_calls: '', tool_call_id: '', tool_name: '', is_error: 0, created_at: '' })
      messages.push({ id: nextId++, conversation_id: cid, role: 'assistant', content: 'answer', reasoning: '', tool_calls: '', tool_call_id: '', tool_name: '', is_error: 0, created_at: '' })
    }),
    chatMessages: vi.fn(async (cid: number) =>
      messages.filter((m) => m.conversation_id === cid).map((m) => ({ ...m }))
    ),
    chatDelete: vi.fn(async () => undefined),
    chatCancel: vi.fn(async () => undefined),
  }
  return { api, conversations, messages }
}

let fake: ReturnType<typeof makeFake>

beforeEach(() => {
  fake = makeFake()
  ;(globalThis as any).window = { picoaide: fake.api }
  useChatStore.setState({ conversations: [], activeId: null, messages: [], streaming: false, streamingText: '', mode: 'ask', localError: null })
  useConnectionStore.setState({ status: 'online' })
})

describe('chat store', () => {
  it('newConversation creates a conversation and selects it', async () => {
    const id = await useChatStore.getState().newConversation()
    expect(id).toBe(1)
    expect(fake.api.chatNew).toHaveBeenCalledWith({ mode: 'ask' })
    expect(useChatStore.getState().activeId).toBe(1)
    expect(useChatStore.getState().conversations).toHaveLength(1)
  })

  it('sendMessage creates a conversation when none is active and calls chatAsk', async () => {
    await useChatStore.getState().sendMessage('你好')
    expect(fake.api.chatNew).toHaveBeenCalled()
    expect(fake.api.chatAsk).toHaveBeenCalledWith(1, '你好')
    const s = useChatStore.getState()
    expect(s.streaming).toBe(false)
    expect(s.messages.some((m) => m.role === 'user' && m.content === '你好')).toBe(true)
    expect(s.messages.some((m) => m.role === 'assistant' && m.content === 'answer')).toBe(true)
  })

  it('refuses to send while offline and surfaces a local error', async () => {
    useConnectionStore.setState({ status: 'offline' })
    await useChatStore.getState().sendMessage('你好')
    expect(fake.api.chatAsk).not.toHaveBeenCalled()
    expect(useChatStore.getState().localError).toContain('网络已断开')
  })

  it('onAgentEvent text_delta appends to the streaming text, done finalizes from DB', async () => {
    const id = await useChatStore.getState().newConversation()
    useChatStore.getState().onAgentEvent({ type: 'text_delta', data: '流式' })
    useChatStore.getState().onAgentEvent({ type: 'text_delta', data: '增量' })
    expect(useChatStore.getState().streamingText).toBe('流式增量')
    // 引擎在 done 前已把 assistant 落库(镜像 fake)
    fake.messages.push({ id: 2, conversation_id: id, role: 'assistant', content: 'answer', reasoning: '', tool_calls: '', tool_call_id: '', tool_name: '', is_error: 0, created_at: '' })
    const done: AgentEvent = { type: 'done', data: { usage: { prompt_tokens: 1, completion_tokens: 1 } } }
    useChatStore.getState().onAgentEvent(done)
    expect(useChatStore.getState().streamingText).toBe('')
    await vi.waitFor(() => {
      expect(useChatStore.getState().messages.some((m) => m.role === 'assistant' && m.content === 'answer')).toBe(true)
    })
    expect(useChatStore.getState().activeId).toBe(id)
  })

  it('error event surfaces the message and stops streaming', () => {
    useChatStore.setState({ streaming: true })
    useChatStore.getState().onAgentEvent({ type: 'error', data: 'upstream 502' })
    const s = useChatStore.getState()
    expect(s.streaming).toBe(false)
    expect(s.localError).toContain('upstream 502')
  })
})
