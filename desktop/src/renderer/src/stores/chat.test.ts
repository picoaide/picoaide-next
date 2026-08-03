import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../main/agent/events'
import { useChatStore } from './chat'
import { useConnectionStore } from './connection'

interface FakePicoaide {
  chatNew: ReturnType<typeof vi.fn>
  chatList: ReturnType<typeof vi.fn>
  chatAsk: ReturnType<typeof vi.fn>
  chatContinue: ReturnType<typeof vi.fn>
  approvePlan: ReturnType<typeof vi.fn>
  chatMessages: ReturnType<typeof vi.fn>
  chatArtifacts: ReturnType<typeof vi.fn>
  chatDelete: ReturnType<typeof vi.fn>
  chatCancel: ReturnType<typeof vi.fn>
  listRunningConversations: ReturnType<typeof vi.fn>
  projectList: ReturnType<typeof vi.fn>
  projectCreate: ReturnType<typeof vi.fn>
  projectDelete: ReturnType<typeof vi.fn>
  moveConversation: ReturnType<typeof vi.fn>
}

function makeFake() {
  const conversations: Record<string, any>[] = []
  const messages: Record<string, any>[] = []
  const artifacts: Record<string, any>[] = []
  const projects: Record<string, any>[] = []
  let nextId = 1
  const api: FakePicoaide = {
    chatNew: vi.fn(async (input?: { mode?: string; projectId?: number | null }) => {
      const id = nextId++
      conversations.push({ id, title: '', mode: input?.mode ?? 'ask', status: 'done', model: '', workspace: '', project_id: input?.projectId ?? null, created_at: '', updated_at: '' })
      return id
    }),
    chatList: vi.fn(async () => conversations.map((c) => ({ ...c }))),
    chatAsk: vi.fn(async (cid: number, content: string) => {
      // 镜像引擎行为:ask 结束前把 user + assistant 都落库
      messages.push({ id: nextId++, conversation_id: cid, role: 'user', content, reasoning: '', tool_calls: '', tool_call_id: '', tool_name: '', is_error: 0, created_at: '' })
      messages.push({ id: nextId++, conversation_id: cid, role: 'assistant', content: 'answer', reasoning: '', tool_calls: '', tool_call_id: '', tool_name: '', is_error: 0, created_at: '' })
    }),
    chatContinue: vi.fn(async () => undefined),
    approvePlan: vi.fn(async () => undefined),
    chatMessages: vi.fn(async (cid: number) =>
      messages.filter((m) => m.conversation_id === cid).map((m) => ({ ...m }))
    ),
    chatArtifacts: vi.fn(async (cid: number) =>
      artifacts.filter((a) => a.conversation_id === cid).map((a) => ({ ...a }))
    ),
    chatDelete: vi.fn(async () => undefined),
    chatCancel: vi.fn(async () => undefined),
    listRunningConversations: vi.fn(async () => []),
    projectList: vi.fn(async () => projects.map((p) => ({ ...p }))),
    projectCreate: vi.fn(async (input: { name: string; path: string }) => {
      const id = nextId++
      projects.push({ id, name: input.name, path: input.path, created_at: '' })
      return id
    }),
    projectDelete: vi.fn(async () => undefined),
    moveConversation: vi.fn(async () => undefined),
  }
  return { api, conversations, messages, artifacts, projects }
}

let fake: ReturnType<typeof makeFake>

beforeEach(() => {
  fake = makeFake()
  ;(globalThis as any).window = { picoaide: fake.api }
  useChatStore.setState({ conversations: [], activeId: null, messages: [], artifacts: [], interrupted: [], streaming: false, streamingText: '', mode: 'ask', localError: null })
  useConnectionStore.setState({ status: 'online' })
})

describe('chat store', () => {
  it('newConversation creates a conversation and selects it', async () => {
    const id = (await useChatStore.getState().newConversation())!
    expect(id).toBe(1)
    expect(fake.api.chatNew).toHaveBeenCalledWith({ mode: 'ask', projectId: null })
    expect(useChatStore.getState().activeId).toBe(1)
    expect(useChatStore.getState().conversations).toHaveLength(1)
  })

  it('newConversation passes activeProjectId to chatNew', async () => {
    useChatStore.setState({ projects: [{ id: 2, name: 'P2', path: '/p2', created_at: '' }], activeProjectId: 2 })
    await useChatStore.getState().newConversation()
    expect(fake.api.chatNew).toHaveBeenCalledWith({ mode: 'ask', projectId: 2 })
  })

  it('createProject adds to the list and returns the id', async () => {
    useChatStore.setState({ projects: [] })
    const id = await useChatStore.getState().createProject({ name: 'P1', path: '/p1' })
    expect(id).toBeGreaterThan(0)
    expect(useChatStore.getState().projects).toHaveLength(1)
    expect(useChatStore.getState().projects[0]).toMatchObject({ name: 'P1', path: '/p1' })
  })

  it('deleteProject removes it and clears activeProjectId', async () => {
    useChatStore.setState({ projects: [{ id: 1, name: 'P', path: '/p', created_at: '' }], activeProjectId: 1 })
    await useChatStore.getState().deleteProject(1)
    expect(useChatStore.getState().projects).toHaveLength(0)
    expect(useChatStore.getState().activeProjectId).toBeNull()
  })

  it('moveConversation reloads conversations and projects', async () => {
    useChatStore.setState({ conversations: [], projects: [] })
    await useChatStore.getState().moveConversation(1, 2)
    expect(fake.api.moveConversation).toHaveBeenCalledWith(1, 2)
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
    const id = (await useChatStore.getState().newConversation())!
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

  it('selectConversation loads artifacts for the conversation', async () => {
    const id = (await useChatStore.getState().newConversation())!
    fake.artifacts.push({ id: 1, conversation_id: id, path: '/w/r.md', type: 'report', size: 9, created_at: '' })
    await useChatStore.getState().selectConversation(id)
    expect(useChatStore.getState().artifacts).toEqual([
      { id: 1, conversation_id: id, path: '/w/r.md', type: 'report', size: 9, created_at: '' },
    ])
  })

  it('artifact events append live and done reloads from DB', async () => {
    const id = (await useChatStore.getState().newConversation())!
    useChatStore.getState().onAgentEvent({ type: 'artifact', data: { path: '/w/a.md', type: 'report', size: 1 } })
    expect(useChatStore.getState().artifacts.map((a) => a.path)).toEqual(['/w/a.md'])
    useChatStore.getState().onAgentEvent({ type: 'done', data: {} })
    await vi.waitFor(() => {
      expect(useChatStore.getState().artifacts).toEqual([])
    })
  })

  it('approvePlan(true) streams until completion then reloads conversations', async () => {
    const id = (await useChatStore.getState().newConversation())!
    useChatStore.getState().approvePlan(id, true)
    expect(useChatStore.getState().streaming).toBe(true)
    await vi.waitFor(() => {
      expect(fake.api.approvePlan).toHaveBeenCalledWith(id, true)
      expect(useChatStore.getState().streaming).toBe(false)
    })
  })

  it('checkInterrupted surfaces running conversations; continueConversation selects and resumes', async () => {
    const id = (await useChatStore.getState().newConversation())!
    fake.api.listRunningConversations.mockResolvedValue([
      { id, title: '中断任务', mode: 'craft', status: 'running', model: '', workspace: '', project_id: null, created_at: '', updated_at: '' },
    ])
    await useChatStore.getState().checkInterrupted()
    expect(useChatStore.getState().interrupted).toHaveLength(1)
    await useChatStore.getState().continueConversation(id)
    expect(fake.api.chatContinue).toHaveBeenCalledWith(id)
    expect(useChatStore.getState().interrupted).toEqual([])
    expect(useChatStore.getState().activeId).toBe(id)
  })

  it('onInterrupted merges without clobbering an existing prompt', () => {
    useChatStore.getState().onInterrupted([{ id: 1, title: 'a', mode: 'craft', status: 'running', model: '', workspace: '', project_id: null, created_at: '', updated_at: '' }])
    useChatStore.getState().onInterrupted([{ id: 2, title: 'b', mode: 'craft', status: 'running', model: '', workspace: '', project_id: null, created_at: '', updated_at: '' }])
    expect(useChatStore.getState().interrupted.map((c) => c.id)).toEqual([1])
    useChatStore.getState().clearInterrupted()
    expect(useChatStore.getState().interrupted).toEqual([])
  })
})
