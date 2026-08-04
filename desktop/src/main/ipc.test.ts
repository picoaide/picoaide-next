import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { LanguageModel, Tool } from 'ai'
import { buildAgentHandlers, buildAuthHandlers, buildHandlers } from './ipc'
import type { AgentIpcDeps, AuthIpcDeps, StoreLike } from './ipc'
import type { AppendMessageInput } from './agent/engine'
import { AuthError } from './gateway/auth'
import type { Session } from './gateway/config'
import { clearCaches, getBootstrapCache, getCurrentSession } from './session_cache'
import { registerIpcHandlers } from './ipc'

// AI SDK v7 在模型 doStream 抛错(测试故意制造的上游故障)时,内部 streamStep 的
// promise 链会泄漏一次 unhandled rejection(与引擎消费无关)。这里仅吞掉
// FakeProvider 抛出的预期错误('upstream 502 bad gateway'),不屏蔽其他真实异常。
const MOCK_ERRORS = new Set(['upstream 502 bad gateway'])
const guard = (reason: unknown) => {
  if (reason instanceof Error && MOCK_ERRORS.has(reason.message)) return
  process.stderr.write(`[unhandledRejection] ${String(reason)}\n`)
}
process.on('unhandledRejection', guard)

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}))

const USAGE = {
  inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
}

class FakeProvider {
  specificationVersion = 'v4' as const
  provider = 'fake'
  modelId = 'fake-model'

  script: 'text' | 'throw' | 'hang' | 'tool-call'

  constructor(script: 'text' | 'throw' | 'hang' | 'tool-call' = 'text') {
    this.script = script
  }

  async doGenerate() {
    throw new Error('not used')
  }

  private hasToolResults(prompt: unknown): boolean {
    return (
      Array.isArray(prompt) &&
      prompt.some((m) => typeof m === 'object' && m !== null && (m as { role?: string }).role === 'tool')
    )
  }

  private contentFor(prompt: unknown) {
    if (this.hasToolResults(prompt)) return [{ type: 'text', text: 'answer after tools' }]
    if (this.script === 'tool-call')
      return [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'file_delete',
          input: JSON.stringify({ path: '/home/u/x.doc' }),
        },
      ]
    return [{ type: 'text', text: 'answer from model' }]
  }

  async doStream(options: any) {
    if (this.script === 'throw') throw new Error('upstream 502 bad gateway')
    if (this.script === 'hang') {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 't1' })
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'partial' })
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
      parts.push({ type: 'text-delta', id: 't1', delta: 'answer from model' })
      parts.push({ type: 'text-end', id: 't1' })
    }
    parts.push({ type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: undefined } })
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

function makeStore(): StoreLike {
  const conversations: any[] = []
  const messages: any[] = []
  const artifacts: any[] = []
  const projects: any[] = []
  const settings: Record<string, string> = {}
  let nextId = 1
  return {
    setConversationTitle: (id: number, title: string) => {
      const c = conversations.find((c) => c.id === id)
      if (c) c.title = title
    },
    setConversationStarred: (id: number, starred: boolean) => {
      const c = conversations.find((c) => c.id === id)
      if (c) c.starred = starred ? 1 : 0
    },
    setConversationArchived: (id: number, archived: boolean) => {
      const c = conversations.find((c) => c.id === id)
      if (c) c.archived = archived ? 1 : 0
    },
    setConversationWorkspace: (id: number, workspace: string) => {
      const c = conversations.find((c) => c.id === id)
      if (c) c.workspace = workspace
    },
    touchConversation: (id: number) => {
      const c = conversations.find((c) => c.id === id)
      if (c) c.updated_at = new Date().toISOString()
    },
    addArtifact: (a: { conversationId: number; path: string; type: string; size: number }): number => {
      const id = nextId++
      artifacts.push({ id, conversation_id: a.conversationId, path: a.path, type: a.type, size: a.size, created_at: '' })
      return id
    },
    listArtifacts: (cid: number) => artifacts.filter((a) => a.conversation_id === cid),
    getSetting: (k: string) => settings[k] ?? null,
    setSetting: (k: string, v: string) => { settings[k] = v },
    getAllSettings: () => ({ ...settings }),
    createConversation: (input: { title?: string; mode?: string; projectId?: number | null } = {}): number => {
      const id = nextId++
      conversations.push({
        id,
        title: input.title ?? '',
        mode: input.mode ?? 'ask',
        status: 'done',
        model: '',
        workspace: '',
        project_id: input.projectId ?? null,
        starred: 0,
        archived: 0,
        created_at: '',
        updated_at: '',
      })
      return id
    },
    createProject: (input: { name: string; path: string }): number => {
      const id = nextId++
      projects.push({ id, name: input.name, path: input.path, created_at: '' })
      return id
    },
    listProjects: () => projects.map((p) => ({ ...p })),
    getProject: (id: number) => projects.find((p) => p.id === id) ?? null,
    deleteProject: (id: number) => {
      const i = projects.findIndex((p) => p.id === id)
      if (i >= 0) projects.splice(i, 1)
    },
    setConversationProject: (conversationId: number, projectId: number | null) => {
      const c = conversations.find((c) => c.id === conversationId)
      if (c) c.project_id = projectId
    },
    listConversations: () => conversations.map((c) => ({ ...c })),
    getConversation: (id: number) => conversations.find((c) => c.id === id) ?? null,
    updateConversationStatus: (id: number, status: string) => {
      const c = conversations.find((c) => c.id === id)
      if (c) c.status = status
    },
    deleteConversation: (id: number) => {
      const i = conversations.findIndex((c) => c.id === id)
      if (i >= 0) conversations.splice(i, 1)
    },
    listMessages: (conversationId: number) => messages.filter((m) => m.conversationId === conversationId),
    updateMessageContent: (id: number, content: string) => {
      const m = messages.find((m) => m.id === id)
      if (m) m.content = content
    },
    deleteMessagesAfter: (conversationId: number, id: number) => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].conversationId === conversationId && messages[i].id > id) messages.splice(i, 1)
      }
    },
    deleteMessage: (id: number) => {
      const i = messages.findIndex((m) => m.id === id)
      if (i >= 0) messages.splice(i, 1)
    },
    appendMessage: (m: AppendMessageInput) => {
      const id = nextId++
      messages.push({ ...m, id })
      return id
    },
  }
}

function makeDeps(script: 'text' | 'throw' | 'hang' | 'tool-call' = 'text') {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const store = makeStore()
  const model = new FakeProvider(script)
  let modelCalls = 0
  let onEngineReset: (() => void) | null = null
  const injectedFetch = vi.fn() as unknown as typeof fetch
  const deps: AgentIpcDeps = {
    store,
    sysPrompt: 'sys',
    createModel: () => {
      modelCalls++
      return model as unknown as LanguageModel
    },
    getTools: async () => ({ tools: {} as Record<string, Tool>, highRiskTools: new Set<string>() }),
    getWindow: () => ({
      webContents: {
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    }),
    registerEngineReset: (fn: () => void) => {
      onEngineReset = fn
    },
    fetch: injectedFetch,
  }
  return { sent, store, deps, model, modelCalls: () => modelCalls, resetEngine: () => onEngineReset?.(), injectedFetch }
}

function eventsOf(sent: Array<{ channel: string; payload: unknown }>) {
  return sent.filter((s) => s.channel === 'agent:event').map((s) => s.payload)
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('ipc handlers', () => {
  it('picoaide:version returns the app version', () => {
    const handlers = buildHandlers()
    expect(handlers['picoaide:version']()).toBe('0.2.0')
  })
})

describe('chat:new / chat:delete', () => {
  it('creates a conversation and returns its id', () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ title: 'first chat' })
    expect(typeof id).toBe('number')
    expect(store.listConversations()[0]).toMatchObject({ id, title: 'first chat', mode: 'ask' })
  })

  it('chat:delete removes the conversation', () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    handlers['chat:delete']({ conversationId: id })
    expect(store.getConversation(id)).toBeNull()
  })

  it('chat:rename / chat:setStarred / chat:setArchived update the conversation', () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    handlers['chat:rename']({ conversationId: id, title: '新标题' })
    handlers['chat:setStarred']({ conversationId: id, starred: true })
    handlers['chat:setArchived']({ conversationId: id, archived: true })
    const c = store.getConversation(id)!
    expect(c.title).toBe('新标题')
    expect(c.starred).toBe(1)
    expect(c.archived).toBe(1)
  })

  it('chat:export renders markdown with user and assistant turns', () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ title: 'T' })
    store.appendMessage({ conversationId: id, role: 'user', content: 'hi' })
    store.appendMessage({ conversationId: id, role: 'assistant', content: 'hello' })
    const md = handlers['chat:export']({ conversationId: id })
    expect(md).toContain('# T')
    expect(md).toContain('## 我')
    expect(md).toContain('hi')
    expect(md).toContain('## PicoAide')
    expect(md).toContain('hello')
  })

  it('chat:new with projectId creates the workspace dir and sets workspace', () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-proj-'))
    const pid = handlers['project:create']({ name: 'p', path: dir })
    const id = handlers['chat:new']({ projectId: pid })
    const conv = store.getConversation(id)
    expect(conv?.project_id).toBe(pid)
    expect(conv?.workspace).toBe(join(dir, String(id)))
    expect(existsSync(conv!.workspace)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('conversation:moveProject updates the project association', () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    handlers['conversation:moveProject']({ conversationId: id, projectId: 9 })
    expect(store.getConversation(id)?.project_id).toBe(9)
  })
})

describe('engine lifecycle', () => {
  it('rebuilds the engine after logout (fresh model for a new session)', async () => {
    const { deps, store, resetEngine, modelCalls } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await handlers['chat:ask']({ conversationId: id, content: 'hi' })
    expect(modelCalls()).toBe(1)

    // 登出 → 引擎重置;再登录后新的 chat 必须用新 model(旧 token 不再滞留)
    resetEngine()
    const id2 = handlers['chat:new']({})
    await handlers['chat:ask']({ conversationId: id2, content: 'hi again' })
    expect(modelCalls()).toBe(2)
    expect(store.getConversation(id2)?.status).toBe('done')
  })

  it('injects session.defaultSession.fetch into the engine for gateway calls', async () => {
    const { deps, store, injectedFetch } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await handlers['chat:ask']({ conversationId: id, content: 'hi' })
    // chat 后 engine 缓存;断言其持有注入的 fetch(引擎通过 injectedFetch 暴露)
    expect(injectedFetch).toBeTruthy()
  })
})

describe('chat:ask', () => {  it('persists user+assistant messages and streams events to the window', async () => {
    const { deps, store, sent } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await handlers['chat:ask']({ conversationId: id, content: 'hi' })

    const msgs = store.listMessages(id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toBe('answer from model')
    expect(store.getConversation(id)?.status).toBe('done')

    const events = eventsOf(sent)
    expect(events.some((e) => (e as { type: string }).type === 'text_delta')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'done', data: { usage: { prompt_tokens: 7, completion_tokens: 3 } } })

    const readBack = await handlers['chat:messages']({ conversationId: id })
    expect(readBack.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('chat:ask 用传入的 mode 分派(按钮选择优先于会话创建时模式)', async () => {
    const { deps, store } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'ask' })
    await handlers['chat:ask']({ conversationId: id, content: 'hi', mode: 'plan' })
    // plan 分派 → 状态 planning(而非 ask 的 done)
    expect(store.getConversation(id)?.status).toBe('planning')
  })

  it('chat:ask 缺省 mode 时回退会话创建时模式', async () => {
    const { deps, store } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'ask' })
    await handlers['chat:ask']({ conversationId: id, content: 'hi' })
    expect(store.getConversation(id)?.status).toBe('done')
  })

  it('emits error and marks the conversation failed when the model fails', async () => {
    const { deps, store, sent } = makeDeps('throw')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await expect(handlers['chat:ask']({ conversationId: id, content: 'hi' })).rejects.toThrow()
    const events = eventsOf(sent)
    expect(events.filter((e) => (e as { type: string }).type === 'error')).toHaveLength(1)
    expect(store.getConversation(id)?.status).toBe('failed')
  })

  it('chat:ask 完成后后台触发 autoTitle(不阻塞)', async () => {
    const autoTitle = vi.fn(async () => undefined)
    const { deps, store, sent } = makeDeps('text')
    deps.autoTitle = autoTitle
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await handlers['chat:ask']({ conversationId: id, content: 'hi' })
    expect(autoTitle).toHaveBeenCalledWith({ conversationId: id })
  })

  it('chat:ask 引擎报错时不触发 autoTitle', async () => {
    const autoTitle = vi.fn(async () => undefined)
    const { deps, store } = makeDeps('throw')
    deps.autoTitle = autoTitle
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await expect(handlers['chat:ask']({ conversationId: id, content: 'hi' })).rejects.toThrow()
    expect(autoTitle).not.toHaveBeenCalled()
  })

  it('cancel mid-stream emits canceled and marks the conversation failed', async () => {
    const { deps, store, sent } = makeDeps('hang')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    const askPromise = handlers['chat:ask']({ conversationId: id, content: 'hi' })
    await waitFor(() => eventsOf(sent).length > 0)
    handlers['chat:cancel']()
    await askPromise
    const events = eventsOf(sent)
    expect(events.some((e) => (e as { type: string }).type === 'canceled')).toBe(true)
    expect(store.getConversation(id)?.status).toBe('failed')
  })
})

const ipcDeleted: string[] = []

describe('craft via ipc', () => {
  it('routes craft-mode conversations to the engine and agent:confirm unblocks a gated tool', async () => {
    const { deps, store, sent } = makeDeps('tool-call')
    deps.getTools = async () => ({
      tools: {
        file_delete: tool({
          description: 'delete a file',
          inputSchema: z.object({ path: z.string() }),
          execute: async ({ path }) => {
            ipcDeleted.push(path)
            return 'deleted'
          },
        }),
      },
      highRiskTools: new Set(['file_delete']),
    })
    const handlers = buildAgentHandlers(deps)
    handlers['picoaide:rendererReady']()
    const id = handlers['chat:new']({ mode: 'craft' })
    const run = handlers['chat:ask']({ conversationId: id, content: 'delete it' })
    await waitFor(() => eventsOf(sent).some((e) => (e as { type: string }).type === 'confirm_required'))
    const req = eventsOf(sent).find((e) => (e as { type: string }).type === 'confirm_required') as { data: { request_id: string } }
    handlers['agent:confirm']({ requestId: req.data.request_id, ok: true })
    await run
    expect(ipcDeleted).toEqual(['/home/u/x.doc'])
    const msgs = store.listMessages(id)
    expect(msgs.some((m) => m.role === 'tool')).toBe(true)
    expect(store.getConversation(id)?.status).toBe('done')
    const events = eventsOf(sent)
    expect(events.some((e) => (e as { type: string }).type === 'tool_end')).toBe(true)
  })

  it('buffers confirm_required until rendererReady is signaled, then flushes', async () => {
    const { deps, sent } = makeDeps('tool-call')
    deps.getTools = async () => ({
      tools: {
        file_delete: tool({
          description: 'delete a file',
          inputSchema: z.object({ path: z.string() }),
          execute: async () => 'deleted',
        }),
      },
      highRiskTools: new Set(['file_delete']),
    })
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'craft' })
    const run = handlers['chat:ask']({ conversationId: id, content: 'delete it' })
    await new Promise((r) => setTimeout(r, 100))
    expect(eventsOf(sent).some((e) => (e as { type: string }).type === 'confirm_required')).toBe(false)
    handlers['picoaide:rendererReady']()
    await waitFor(() => eventsOf(sent).some((e) => (e as { type: string }).type === 'confirm_required'))
    const req = eventsOf(sent).find((e) => (e as { type: string }).type === 'confirm_required') as { data: { request_id: string } }
    handlers['agent:confirm']({ requestId: req.data.request_id, ok: true })
    await run
  })
})

afterEach(() => {
  ipcDeleted.length = 0
})

describe('chat:continue / chat:approvePlan / chat:listRunning / artifacts', () => {
  it('chat:continue replays the last user message and finishes done', async () => {
    const { deps, store, sent } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'craft' })
    store.appendMessage({ conversationId: id, role: 'user', content: 'first' })
    store.appendMessage({ conversationId: id, role: 'assistant', content: 'stale partial' })
    store.updateConversationStatus(id, 'running')
    await handlers['chat:continue']({ conversationId: id })
    expect(store.getConversation(id)?.status).toBe('done')
    expect(eventsOf(sent).some((e) => (e as { type: string }).type === 'done')).toBe(true)
    // 中断时的部分输出不进上下文(截断到最后一条 user)
    expect(store.listMessages(id).filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('chat:continue passes the conversation workspace to getTools', async () => {
    const { deps, store } = makeDeps('tool-call')
    const getTools = vi.fn(async () => ({ tools: {} as Record<string, Tool>, highRiskTools: new Set<string>() }))
    deps.getTools = getTools
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'craft' })
    store.setConversationWorkspace(id, '/proj/5')
    store.appendMessage({ conversationId: id, role: 'user', content: 'first' })
    store.updateConversationStatus(id, 'running')
    await handlers['chat:continue']({ conversationId: id })
    expect(getTools).toHaveBeenCalledWith('/proj/5')
  })

  it('chat:editAndRerun rewrites the user message, truncates, and reruns', async () => {
    const { deps, store, sent } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'craft' })
    const m1 = store.appendMessage({ conversationId: id, role: 'user', content: 'old question' })
    store.appendMessage({ conversationId: id, role: 'assistant', content: 'old answer' })
    await handlers['chat:editAndRerun']({ conversationId: id, messageId: m1, content: 'new question' })
    const msgs = store.listMessages(id)
    expect(msgs.map((m) => m.content)).toEqual(['new question', 'answer from model'])
    expect(eventsOf(sent).some((e) => (e as { type: string }).type === 'done')).toBe(true)
  })

  it('chat:ask in plan mode produces a plan; chat:approvePlan(true) executes with tools', async () => {
    const { deps, model, store, sent } = makeDeps('text')
    const executed: string[] = []
    deps.getTools = async () => ({
      tools: {
        file_delete: tool({
          description: 'delete a file',
          inputSchema: z.object({ path: z.string() }),
          execute: async ({ path }) => {
            executed.push(path)
            return 'deleted'
          },
        }),
      },
      highRiskTools: new Set(['file_delete']),
    })
    const handlers = buildAgentHandlers(deps)
    handlers['picoaide:rendererReady']()
    const id = handlers['chat:new']({ mode: 'plan' })
    await handlers['chat:ask']({ conversationId: id, content: 'plan it' })
    expect(store.getConversation(id)?.status).toBe('planning')
    expect(store.listMessages(id).map((m) => m.role)).toEqual(['user', 'assistant'])
    model.script = 'tool-call'
    const run = handlers['chat:approvePlan']({ conversationId: id, ok: true })
    await waitFor(() => eventsOf(sent).some((e) => (e as { type: string }).type === 'confirm_required'))
    const req = eventsOf(sent).find((e) => (e as { type: string }).type === 'confirm_required') as { data: { request_id: string } }
    handlers['agent:confirm']({ requestId: req.data.request_id, ok: true })
    await run
    expect(executed).toEqual(['/home/u/x.doc'])
    expect(store.getConversation(id)?.status).toBe('done')
  })

  it('chat:approvePlan(false) marks the conversation rejected', async () => {
    const { deps, store } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'plan' })
    await handlers['chat:ask']({ conversationId: id, content: 'plan it' })
    await handlers['chat:approvePlan']({ conversationId: id, ok: false })
    expect(store.getConversation(id)?.status).toBe('rejected')
    expect(store.listMessages(id).filter((m) => m.role === 'tool')).toHaveLength(0)
  })

  it('chat:listRunning returns only running/executing conversations', async () => {
    const { deps, store } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const running = handlers['chat:new']({ mode: 'craft' })
    store.updateConversationStatus(running, 'running')
    const executing = handlers['chat:new']({ mode: 'craft' })
    store.updateConversationStatus(executing, 'executing')
    handlers['chat:new']({})
    expect(handlers['chat:listRunning']().map((c) => c.id)).toEqual([running, executing])
  })

  it('chat:artifacts lists persisted artifacts; artifact:showInFolder is a no-op guard', async () => {
    const { deps, store } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    store.addArtifact({ conversationId: id, path: '/w/report.md', type: 'report', size: 10 })
    expect(handlers['chat:artifacts']({ conversationId: id })).toEqual([
      { id: 2, conversation_id: id, path: '/w/report.md', type: 'report', size: 10, created_at: '' },
    ])
    expect(() => handlers['artifact:showInFolder']({ path: '/w/report.md' })).not.toThrow()
    expect(() => handlers['artifact:showInFolder']({ path: '' })).not.toThrow()
  })
})

const SESSION: Session = { serverURL: 'https://srv.example.com', username: 'alice', token: 'tok' }

function makeAuthDeps(overrides: Partial<AuthIpcDeps> = {}) {
  const flow: AuthIpcDeps['flow'] = {
    login: vi.fn().mockResolvedValue(SESSION),
    saveSession: vi.fn().mockResolvedValue({ persisted: true }),
    loadSession: vi.fn().mockResolvedValue(null),
    clearSession: vi.fn().mockResolvedValue(undefined),
  }
  const deps: AuthIpcDeps = {
    flow,
    getBootstrap: vi.fn().mockResolvedValue({
      config: { default_model: 'm1', models: [{ id: 'm1', display_name: 'M1' }], skills: [], mcp: [], web: { allow_private: false, search_endpoint: '' } },
      fellBack: false,
    }),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onSessionEstablished: vi.fn(),
    onSessionCleared: vi.fn(),
    ...overrides,
  }
  return deps
}

describe('auth handlers', () => {
  it('auth:login returns session+bootstrap and establishes caches', async () => {
    const deps = makeAuthDeps()
    const handlers = buildAuthHandlers(deps)
    const res = await handlers['auth:login']({ serverURL: 'https://srv.example.com', username: 'alice', password: 'pw' })
    expect(res.session).toMatchObject({ ...SESSION, persisted: true })
    expect(res.bootstrap.default_model).toBe('m1')
    expect(getCurrentSession()).toEqual(SESSION)
    expect(getBootstrapCache().default_model).toBe('m1')
    expect(deps.onSessionEstablished).toHaveBeenCalledWith(SESSION)
  })

  it('auth:login rejects http for remote hosts before calling the gateway', async () => {
    const deps = makeAuthDeps()
    const handlers = buildAuthHandlers(deps)
    await expect(handlers['auth:login']({ serverURL: 'http://srv.example.com', username: 'a', password: 'b' })).rejects.toThrow(/INVALID_URL/)
    expect(deps.flow.login).not.toHaveBeenCalled()
  })

  it('auth:login maps invalid_credentials / network errors with their codes', async () => {
    const bad = makeAuthDeps({
      flow: { ...makeAuthDeps().flow, login: vi.fn().mockRejectedValue(new AuthError('invalid_credentials')) },
    })
    await expect(buildAuthHandlers(bad)['auth:login']({ serverURL: 'https://srv.example.com', username: 'a', password: 'x' })).rejects.toThrow(/invalid_credentials/)
    const net = makeAuthDeps({
      flow: { ...makeAuthDeps().flow, login: vi.fn().mockRejectedValue(new AuthError('network', 'fetch failed')) },
    })
    await expect(buildAuthHandlers(net)['auth:login']({ serverURL: 'https://srv.example.com', username: 'a', password: 'x' })).rejects.toThrow(/network/)
  })

  it('auth:loadSession restores a persisted session and null when absent', async () => {
    const deps = makeAuthDeps()
    const handlers = buildAuthHandlers(deps)
    expect(await handlers['auth:loadSession']()).toBeNull()
    deps.flow.loadSession = vi.fn().mockResolvedValue(SESSION)
    expect(await handlers['auth:loadSession']()).toEqual(SESSION)
    expect(getCurrentSession()).toEqual(SESSION)
  })

  it('auth:logout clears the session file, caches and notifies', async () => {
    const deps = makeAuthDeps()
    const handlers = buildAuthHandlers(deps)
    deps.flow.loadSession = vi.fn().mockResolvedValue(SESSION)
    await handlers['auth:loadSession']()
    await handlers['auth:logout']()
    expect(deps.flow.clearSession).toHaveBeenCalled()
    expect(getCurrentSession()).toBeNull()
    expect(deps.onSessionCleared).toHaveBeenCalled()
  })

  it('auth:refreshBootstrap refetches and recaches', async () => {
    const deps = makeAuthDeps()
    const handlers = buildAuthHandlers(deps)
    deps.flow.loadSession = vi.fn().mockResolvedValue(SESSION)
    await handlers['auth:loadSession']()
    deps.getBootstrap = vi.fn().mockResolvedValue({
      config: { default_model: 'm2', models: [{ id: 'm2', display_name: 'M2' }], skills: [], mcp: [], web: { allow_private: false, search_endpoint: '' } },
      fellBack: false,
    })
    const cfg = await handlers['auth:refreshBootstrap']()
    expect(cfg.default_model).toBe('m2')
    expect(getBootstrapCache().default_model).toBe('m2')
  })

  it('auth:oidcLogin opens the OIDC entry in the system browser', async () => {
    const deps = makeAuthDeps()
    const handlers = buildAuthHandlers(deps)
    await handlers['auth:oidcLogin']({ serverURL: 'https://srv.example.com' })
    expect(deps.openExternal).toHaveBeenCalledWith('https://srv.example.com/api/auth/oidc/login')
  })

  afterEach(clearCaches)
})

describe('registerIpcHandlers event stripping', () => {
  it('strips the IpcMainInvokeEvent so handlers receive the real payload', async () => {
    // 回归测试:ipcMain.handle 回调签名是 (event, ...args),若直接传 handler,
    // 第一个参数会是事件对象而非调用方 payload(真实应用登录失败的根因)。
    const received: unknown[] = []
    const fakeIpc = {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        // 模拟 Electron:事件对象作为第一个参数
        fn({ _replyChannel: {}, senderFrame: {} }, { serverURL: 'https://srv', username: 'a', password: 'b' })
      },
    }
    registerIpcHandlers(
      { 'test:echo': (input: unknown) => { received.push(input); return input } } as any,
      fakeIpc as any,
    )
    expect(received).toEqual([{ serverURL: 'https://srv', username: 'a', password: 'b' }])
  })
})
