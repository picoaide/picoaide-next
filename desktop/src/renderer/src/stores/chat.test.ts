import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../main/agent/events'
import { useChatStore } from './chat'
import { useConnectionStore } from './connection'

interface FakePicoaide {
  chatNew: ReturnType<typeof vi.fn>
  chatList: ReturnType<typeof vi.fn>
  chatAsk: ReturnType<typeof vi.fn>
  chatAttach: ReturnType<typeof vi.fn>
  chatQueue: ReturnType<typeof vi.fn>
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
      conversations.push({ id, title: '', mode: input?.mode ?? 'craft', status: 'done', model: '', workspace: '', project_id: input?.projectId ?? null, created_at: '', updated_at: '' })
      return id
    }),
    chatList: vi.fn(async () => conversations.map((c) => ({ ...c }))),
    chatAsk: vi.fn(async (cid: number, content: string) => {
      // 镜像引擎行为:ask 结束前把 user + assistant 都落库
      messages.push({ id: nextId++, conversation_id: cid, role: 'user', content, reasoning: '', tool_calls: '', tool_call_id: '', tool_name: '', is_error: 0, created_at: '' })
      messages.push({ id: nextId++, conversation_id: cid, role: 'assistant', content: 'answer', reasoning: '', tool_calls: '', tool_call_id: '', tool_name: '', is_error: 0, created_at: '' })
    }),
    chatAttach: vi.fn(async (_cid: number, files: Array<{ kind: string; name: string }>) =>
      files.map((f, i) => ({ kind: f.kind, name: f.name, path: `/ws/attachments/${i}.${f.kind === 'image' ? 'png' : f.name}` })),
    ),
    chatContinue: vi.fn(async () => undefined),
    chatQueue: vi.fn(async () => true),
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
  useChatStore.setState({ conversations: [], activeId: null, messages: [], artifacts: [], interrupted: [], streaming: false, streamingText: '', mode: 'craft', localError: null, runSteps: [], runStepCount: 0 })
  useConnectionStore.setState({ status: 'online' })
})

describe('chat store', () => {
  it('requestEditArtifact sends a message referencing the artifact path', async () => {
    useChatStore.setState({ activeId: 5 })
    await useChatStore.getState().requestEditArtifact('/w/report.md')
    expect(fake.api.chatAsk).toHaveBeenCalledWith(5, expect.stringContaining('/w/report.md'), 'craft')
  })

  it('newConversation creates a conversation and selects it', async () => {
    const id = (await useChatStore.getState().newConversation())!
    expect(id).toBe(1)
    expect(fake.api.chatNew).toHaveBeenCalledWith({ mode: 'craft', projectId: null })
    expect(useChatStore.getState().activeId).toBe(1)
    expect(useChatStore.getState().conversations).toHaveLength(1)
  })

  it('newConversation passes activeProjectId to chatNew', async () => {
    useChatStore.setState({ projects: [{ id: 2, name: 'P2', path: '/p2', created_at: '' }], activeProjectId: 2 })
    await useChatStore.getState().newConversation()
    expect(fake.api.chatNew).toHaveBeenCalledWith({ mode: 'craft', projectId: 2 })
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

  it('onChatTitle 实时更新侧边栏会话标题', async () => {
    const id = (await useChatStore.getState().newConversation())!
    expect(useChatStore.getState().conversations[0].title).toBe('')
    useChatStore.getState().onChatTitle(id, '修复登录页样式')
    expect(useChatStore.getState().conversations[0].title).toBe('修复登录页样式')
  })

  it('sendMessage during streaming queues the message instead of asking', async () => {
    useChatStore.setState({ streaming: true, activeId: 1, messages: [] })
    await useChatStore.getState().sendMessage('新消息')
    expect(fake.api.chatQueue).toHaveBeenCalledWith(1, '新消息')
    expect(fake.api.chatAsk).not.toHaveBeenCalled()
  })

  it('sendMessage queue rejection surfaces a local error', async () => {
    fake.api.chatQueue.mockResolvedValue(false)
    useChatStore.setState({ streaming: true, activeId: 1 })
    await useChatStore.getState().sendMessage('x')
    expect(useChatStore.getState().localError).toContain('即将结束')
    expect(fake.api.chatAsk).not.toHaveBeenCalled()
  })

  it('cancel falls back to resetting streaming when no event arrives within 3s', async () => {
    vi.useFakeTimers()
    try {
      useChatStore.setState({ streaming: true, streamingText: '部分文本' })
      await useChatStore.getState().cancel()
      expect(useChatStore.getState().streaming).toBe(true)
      vi.advanceTimersByTime(3000)
      expect(useChatStore.getState().streaming).toBe(false)
      expect(useChatStore.getState().streamingText).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('applyPrompt queues a prompt consumed once by ChatInput', () => {
    useChatStore.getState().applyPrompt('帮我整理桌面文件')
    expect(useChatStore.getState().pendingPrompt).toBe('帮我整理桌面文件')
    expect(useChatStore.getState().consumePrompt()).toBe('帮我整理桌面文件')
    expect(useChatStore.getState().consumePrompt()).toBeNull()
  })

  it('sendMessage creates a conversation when none is active and calls chatAsk', async () => {
    await useChatStore.getState().sendMessage('你好')
    expect(fake.api.chatNew).toHaveBeenCalled()
    expect(fake.api.chatAsk).toHaveBeenCalledWith(1, '你好', 'craft')
    const s = useChatStore.getState()
    expect(s.streaming).toBe(false)
    expect(s.messages.some((m) => m.role === 'user' && m.content === '你好')).toBe(true)
    expect(s.messages.some((m) => m.role === 'assistant' && m.content === 'answer')).toBe(true)
  })

  it('sendMessage passes the current mode so craft runs with tools on any conversation', async () => {
    useChatStore.setState({ mode: 'craft' })
    await useChatStore.getState().sendMessage('帮我打开网页')
    expect(fake.api.chatAsk).toHaveBeenCalledWith(1, '帮我打开网页', 'craft')
  })

  it('sendMessage 首条消息后 activeId 保持,后续消息不新建会话', async () => {
    useChatStore.setState({ activeId: null })
    await useChatStore.getState().sendMessage('第一句')
    const firstId = useChatStore.getState().activeId
    expect(firstId).not.toBeNull()
    fake.api.chatNew.mockClear()
    await useChatStore.getState().sendMessage('第二句')
    expect(fake.api.chatNew).not.toHaveBeenCalled()
    expect(useChatStore.getState().activeId).toBe(firstId)
    expect(useChatStore.getState().messages.every((m) => m.content !== '第二句') === false).toBe(true)
  })

  it('refuses to send while offline and surfaces a local error', async () => {
    useConnectionStore.setState({ status: 'offline' })
    await useChatStore.getState().sendMessage('你好')
    expect(fake.api.chatAsk).not.toHaveBeenCalled()
    expect(useChatStore.getState().localError).toContain('网络已断开')
  })

  it('onAgentEvent text_delta appends to the streaming text, done finalizes from DB', async () => {
    const id = (await useChatStore.getState().newConversation())!
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'text_delta', data: '流式' })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'text_delta', data: '增量' })
    expect(useChatStore.getState().streamingText).toBe('流式增量')
    // 引擎在 done 前已把 assistant 落库(镜像 fake)
    fake.messages.push({ id: 2, conversation_id: id, role: 'assistant', content: 'answer', reasoning: '', tool_calls: '', tool_call_id: '', tool_name: '', is_error: 0, created_at: '' })
    const done: AgentEvent = { conversationId: 1, type: 'done', data: { usage: { prompt_tokens: 1, completion_tokens: 1 } } }
    useChatStore.getState().onAgentEvent(done)
    expect(useChatStore.getState().streamingText).toBe('')
    await vi.waitFor(() => {
      expect(useChatStore.getState().messages.some((m) => m.role === 'assistant' && m.content === 'answer')).toBe(true)
    })
    expect(useChatStore.getState().activeId).toBe(id)
  })

  it('error event surfaces the message and stops streaming', () => {
    useChatStore.setState({ streaming: true, activeId: 1 })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'error', data: 'upstream 502' })
    const s = useChatStore.getState()
    expect(s.streaming).toBe(false)
    expect(s.localError).toContain('upstream 502')
  })

  it('reasoning_delta appends to streamingReasoning; done clears it', () => {
    useChatStore.setState({ activeId: 1 })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'reasoning_delta', data: '先分析需求' })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'reasoning_delta', data: ',再写代码' })
    expect(useChatStore.getState().streamingReasoning).toBe('先分析需求,再写代码')
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'done', data: {} })
    expect(useChatStore.getState().streamingReasoning).toBe('')
  })

  it('selectConversation loads artifacts for the conversation', async () => {
    const id = (await useChatStore.getState().newConversation())!
    fake.artifacts.push({ id: 1, conversation_id: id, path: '/w/r.md', type: 'report', size: 9, created_at: '' })
    await useChatStore.getState().selectConversation(id)
    expect(useChatStore.getState().artifacts).toEqual([
      { id: 1, conversation_id: id, path: '/w/r.md', type: 'report', size: 9, created_at: '' },
    ])
  })

  it('ignores events from other conversations (stale run after switching)', () => {
    // 回归:切会话后旧会话运行的迟到事件不得污染当前视图
    useChatStore.setState({ streaming: true, activeId: 2 })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'text_delta', data: '旧会话文本' })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'error', data: '旧会话错误' })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'done', data: {} })
    const s = useChatStore.getState()
    expect(s.streamingText).toBe('')
    expect(s.localError).toBeNull()
    // 当前会话(2)的事件正常处理
    useChatStore.getState().onAgentEvent({ conversationId: 2, type: 'done', data: {} })
    expect(useChatStore.getState().streaming).toBe(false)
  })

  it('artifact events append live and done reloads from DB', async () => {
    const id = (await useChatStore.getState().newConversation())!
    useChatStore.getState().onAgentEvent({ conversationId: id, type: 'artifact', data: { path: '/w/a.md', type: 'report', size: 1 } })
    expect(useChatStore.getState().artifacts.map((a) => a.path)).toEqual(['/w/a.md'])
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'done', data: {} })
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
      { id, title: '中断任务', mode: 'craft', status: 'running', model: '', workspace: '', project_id: null, starred: 0, archived: 0, created_at: '', updated_at: '' },
    ])
    await useChatStore.getState().checkInterrupted()
    expect(useChatStore.getState().interrupted).toHaveLength(1)
    await useChatStore.getState().continueConversation(id)
    expect(fake.api.chatContinue).toHaveBeenCalledWith(id)
    expect(useChatStore.getState().interrupted).toEqual([])
    expect(useChatStore.getState().activeId).toBe(id)
  })

  it('onInterrupted merges without clobbering an existing prompt', () => {
    useChatStore.getState().onInterrupted([{ id: 1, title: 'a', mode: 'craft', status: 'running', model: '', workspace: '', project_id: null, starred: 0, archived: 0, created_at: '', updated_at: '' }])
    useChatStore.getState().onInterrupted([{ id: 2, title: 'b', mode: 'craft', status: 'running', model: '', workspace: '', project_id: null, starred: 0, archived: 0, created_at: '', updated_at: '' }])
    expect(useChatStore.getState().interrupted.map((c) => c.id)).toEqual([1])
    useChatStore.getState().clearInterrupted()
    expect(useChatStore.getState().interrupted).toEqual([])
  })
})

describe('chat store run steps trajectory', () => {
  it('tool_start appends a running step', () => {
    useChatStore.setState({ activeId: 1 })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'read_file', input: {} } })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't2', name: 'bash', input: {} } })
    expect(useChatStore.getState().runSteps).toEqual([
      { id: 't1', toolName: 'read_file', status: 'running' },
      { id: 't2', toolName: 'bash', status: 'running' },
    ])
  })

  it('tool_end completes the matching step with duration', () => {
    useChatStore.setState({ activeId: 1 })
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'read_file', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'tool_end', data: { id: 't1', name: 'read_file', output: {}, duration_ms: 42 } })
    expect(useChatStore.getState().runSteps).toEqual([{ id: 't1', toolName: 'read_file', status: 'done', durationMs: 42 }])
  })

  it('tool_end without a matching start falls back to the first running step', () => {
    useChatStore.setState({ activeId: 1 })
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'read_file', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'tool_end', data: { id: 'ghost', name: 'read_file', output: {}, duration_ms: 7 } })
    expect(useChatStore.getState().runSteps).toEqual([{ id: 't1', toolName: 'read_file', status: 'done', durationMs: 7 }])
  })

  it('tool_error marks the matching step error', () => {
    useChatStore.setState({ activeId: 1 })
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'bash', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'tool_error', data: { id: 't1', name: 'bash', error: 'boom' } })
    expect(useChatStore.getState().runSteps).toEqual([{ id: 't1', toolName: 'bash', status: 'error' }])
  })

  it('tool_error without a matching id falls back to the first running step', () => {
    useChatStore.setState({ activeId: 1 })
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'bash', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't2', name: 'web_search', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'tool_error', data: { id: 'ghost', name: 'bash', error: 'boom' } })
    expect(useChatStore.getState().runSteps.map((r) => r.status)).toEqual(['error', 'running'])
  })

  it('done collapses the trajectory into a count summary', () => {
    useChatStore.setState({ activeId: 1 })
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'read_file', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'tool_end', data: { id: 't1', name: 'read_file', output: {}, duration_ms: 5 } })
    s.onAgentEvent({ conversationId: 1, type: 'done', data: {} })
    expect(useChatStore.getState().runSteps).toEqual([])
    expect(useChatStore.getState().runStepCount).toBe(1)
  })

  it('canceled clears the trajectory entirely', () => {
    useChatStore.setState({ activeId: 1 })
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'read_file', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'canceled', data: { reason: 'user' } })
    expect(useChatStore.getState().runSteps).toEqual([])
    expect(useChatStore.getState().runStepCount).toBe(0)
  })

  it('session error clears the trajectory entirely', () => {
    useChatStore.setState({ activeId: 1 })
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'read_file', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'error', data: 'upstream 502' })
    expect(useChatStore.getState().runSteps).toEqual([])
    expect(useChatStore.getState().runStepCount).toBe(0)
  })

  it('a new run resets the previous summary', async () => {
    useChatStore.setState({ activeId: 1 })
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: 1, type: 'tool_start', data: { id: 't1', name: 'read_file', input: {} } })
    s.onAgentEvent({ conversationId: 1, type: 'done', data: {} })
    expect(useChatStore.getState().runStepCount).toBe(1)
    await useChatStore.getState().sendMessage('再来一轮')
    expect(useChatStore.getState().runSteps).toEqual([])
    expect(useChatStore.getState().runStepCount).toBe(0)
  })

  it('switching conversations clears the trajectory', async () => {
    const first = (await useChatStore.getState().newConversation())!
    const s = useChatStore.getState()
    s.onAgentEvent({ conversationId: first, type: 'tool_start', data: { id: 't1', name: 'read_file', input: {} } })
    const second = (await useChatStore.getState().newConversation())!
    expect(useChatStore.getState().runSteps).toEqual([])
    await useChatStore.getState().selectConversation(second)
    expect(useChatStore.getState().runSteps).toEqual([])
    expect(useChatStore.getState().runStepCount).toBe(0)
  })
})

describe('chat store attachments', () => {
  it('sendMessage attaches files first, then sends content with refs', async () => {
    useChatStore.setState({ activeId: 1, messages: [] })
    const ok = await useChatStore.getState().sendMessage('看看这张图', [
      { kind: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' },
      { kind: 'file', name: 'data.csv', dataUrl: 'data:text/csv;base64,YQo=' },
    ])
    expect(fake.api.chatAttach).toHaveBeenCalledWith(1, [
      { kind: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' },
      { kind: 'file', name: 'data.csv', dataUrl: 'data:text/csv;base64,YQo=' },
    ])
    expect(fake.api.chatAsk).toHaveBeenCalledWith(1, '[图片: /ws/attachments/0.png]\n[附带文件: /ws/attachments/1.data.csv]\n\n看看这张图', 'craft')
    expect(ok).toBe(true)
  })

  it('sendMessage queues attachments during streaming with refs', async () => {
    useChatStore.setState({ streaming: true, activeId: 1 })
    await useChatStore.getState().sendMessage('补充', [
      { kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AA==' },
    ])
    expect(fake.api.chatAttach).toHaveBeenCalledWith(1, [{ kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AA==' }])
    expect(fake.api.chatQueue).toHaveBeenCalledWith(1, '[图片: /ws/attachments/0.png]\n\n补充')
    expect(fake.api.chatAsk).not.toHaveBeenCalled()
  })

  it('sendMessage allows attachments without text', async () => {
    useChatStore.setState({ activeId: 1, messages: [] })
    const ok = await useChatStore.getState().sendMessage('', [
      { kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AA==' },
    ])
    expect(fake.api.chatAsk).toHaveBeenCalledWith(1, '[图片: /ws/attachments/0.png]', 'craft')
    expect(ok).toBe(true)
  })

  it('sendMessage surfaces attach errors without sending', async () => {
    fake.api.chatAttach.mockRejectedValue(new Error('图片超过 5MB 大小限制'))
    useChatStore.setState({ activeId: 1 })
    const ok = await useChatStore.getState().sendMessage('x', [
      { kind: 'image', name: 'big.png', dataUrl: 'data:image/png;base64,AA==' },
    ])
    expect(ok).toBe(false)
    expect(fake.api.chatAsk).not.toHaveBeenCalled()
    expect(useChatStore.getState().localError).toContain('5MB')
  })

  it('context_usage event sets contextUsage; done clears it', () => {
    useChatStore.setState({ activeId: 1 })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'context_usage', data: { chars: 32_400, budget: 40_000 } })
    expect(useChatStore.getState().contextUsage).toEqual({ chars: 32_400, budget: 40_000 })
    useChatStore.getState().onAgentEvent({ conversationId: 1, type: 'done', data: {} })
    expect(useChatStore.getState().contextUsage).toBeNull()
  })
})
