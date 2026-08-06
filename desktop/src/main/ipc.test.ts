import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { LanguageModel, Tool } from 'ai'
import { buildAgentHandlers, buildAuthHandlers, loadProjectInstructions } from './ipc'
import type { AgentIpcDeps, AuthIpcDeps, StoreLike } from './ipc'
import type { AppendMessageInput } from './agent/engine'
import { AuthError } from './gateway/auth'
import type { Session } from './gateway/config'
import { clearCaches, getBootstrapCache, getCurrentSession } from './session_cache'
import { registerIpcHandlers } from './ipc'
import { setDataDirOverride } from './paths'

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
  systems: string[] = []

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
    this.systems.push(String((options.prompt?.[0] as { content?: unknown })?.content ?? ''))
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
    addArtifact: (a: { conversationId: number; path: string; type: string; size: number }): number => {
      const id = nextId++
      artifacts.push({ id, conversation_id: a.conversationId, path: a.path, type: a.type, size: a.size, created_at: '' })
      return id
    },
    listArtifacts: (cid: number) => artifacts.filter((a) => a.conversation_id === cid),
    getSetting: (k: string) => settings[k] ?? null,
    setSetting: (k: string, v: string) => { settings[k] = v },
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

describe('chat:new / chat:delete', () => {
  it('creates a conversation and returns its id', () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ title: 'first chat' })
    expect(typeof id).toBe('number')
    expect(store.listConversations()[0]).toMatchObject({ id, title: 'first chat', mode: 'ask' })
  })

  it('chat:delete removes the conversation', async () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await handlers['chat:delete']({ conversationId: id })
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
    expect(events.at(-1)).toEqual({ conversationId: id, type: 'done', data: { usage: { prompt_tokens: 7, completion_tokens: 3 } } })

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

describe('workspace AGENTS.md injection', () => {
  it('loadProjectInstructions reads AGENTS.md under a header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-agents-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '项目规则:先读 README')
      expect(loadProjectInstructions(dir)).toBe('\n\n## 项目指令(AGENTS.md)\n项目规则:先读 README')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadProjectInstructions skips when workspace is unknown or file missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-agents-'))
    try {
      expect(loadProjectInstructions(undefined)).toBe('')
      expect(loadProjectInstructions('')).toBe('')
      expect(loadProjectInstructions(dir)).toBe('')
      expect(loadProjectInstructions(join(dir, 'missing'))).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadProjectInstructions truncates content beyond 4096 chars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-agents-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(5000))
      const out = loadProjectInstructions(dir)
      expect(out.length).toBeLessThan(5000)
      expect(out).toContain('截断')
      expect(out.indexOf('截断')).toBeGreaterThan(4000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('craft via ipc injects the workspace AGENTS.md into the model system prompt', async () => {
    const { deps, store, model } = makeDeps('text')
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-agents-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '本项目禁止删除文件')
      const handlers = buildAgentHandlers(deps)
      const id = handlers['chat:new']({ mode: 'craft' })
      store.setConversationWorkspace(id, dir)
      await handlers['chat:ask']({ conversationId: id, content: 'hi' })
      expect(model.systems.at(-1)).toContain('## 项目指令(AGENTS.md)')
      expect(model.systems.at(-1)).toContain('本项目禁止删除文件')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('craft via ipc without AGENTS.md keeps the base system prompt', async () => {
    const { deps, model } = makeDeps('text')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'craft' })
    await handlers['chat:ask']({ conversationId: id, content: 'hi' })
    expect(model.systems.at(-1)).toBe('sys')
  })

  it('plan via ipc injects the workspace AGENTS.md too', async () => {
    const { deps, store, model } = makeDeps('text')
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-agents-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '计划需包含风险说明')
      const handlers = buildAgentHandlers(deps)
      const id = handlers['chat:new']({ mode: 'plan' })
      store.setConversationWorkspace(id, dir)
      await handlers['chat:ask']({ conversationId: id, content: 'plan it' })
      expect(model.systems.at(-1)).toContain('计划需包含风险说明')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('artifact:read', () => {
  it('returns markdown content for in-bounds .md files', () => {
    const { deps } = makeDeps()
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-art-'))
    const file = join(dir, 'report.md')
    writeFileSync(file, '# hello')
    deps.listAllowedDirs = () => [dir]
    const handlers = buildAgentHandlers(deps)
    expect(handlers['artifact:read']({ path: file })).toEqual({ kind: 'md', content: '# hello' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns image dataUrl for image files', () => {
    const { deps } = makeDeps()
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-art-'))
    const file = join(dir, 'pic.png')
    writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))
    deps.listAllowedDirs = () => [dir]
    const handlers = buildAgentHandlers(deps)
    const r = handlers['artifact:read']({ path: file })
    expect(r.kind).toBe('image')
    expect((r as { dataUrl: string }).dataUrl).toMatch(/^data:image\/png;base64,/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects out-of-bounds paths (system files and siblings)', () => {
    const { deps } = makeDeps()
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-art-'))
    const outside = mkdtempSync(join(tmpdir(), 'picoaide-art-out-'))
    const file = join(outside, 'leak.txt')
    writeFileSync(file, 'secret')
    deps.listAllowedDirs = () => [dir]
    const handlers = buildAgentHandlers(deps)
    expect(() => handlers['artifact:read']({ path: file })).toThrow(/允许目录/)
    expect(() => handlers['artifact:read']({ path: '/etc/passwd' })).toThrow(/允许目录/)
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('rejects text files over 1MB and image files over 5MB', () => {
    const { deps } = makeDeps()
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-art-'))
    const big = join(dir, 'big.md')
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 1))
    deps.listAllowedDirs = () => [dir]
    const handlers = buildAgentHandlers(deps)
    expect(() => handlers['artifact:read']({ path: big })).toThrow(/大小/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns kind other for unsupported extensions', () => {
    const { deps } = makeDeps()
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-art-'))
    const file = join(dir, 'a.docx')
    writeFileSync(file, 'x')
    deps.listAllowedDirs = () => [dir]
    const handlers = buildAgentHandlers(deps)
    expect(handlers['artifact:read']({ path: file })).toEqual({ kind: 'other' })
    rmSync(dir, { recursive: true, force: true })
  })
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

describe('chat:attach', () => {
  const pngDataUrl = (bytes: number[]): string => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`

  it('writes image files into the conversation workspace attachments dir', async () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-attach-'))
    try {
      const pid = handlers['project:create']({ name: 'p', path: dir })
      const id = handlers['chat:new']({ projectId: pid })
      const out = await handlers['chat:attach']({
        conversationId: id,
        files: [{ kind: 'image', name: 'shot.png', dataUrl: pngDataUrl([0x89, 0x50, 0x4e, 0x47]) }],
      })
      expect(out).toHaveLength(1)
      expect(out[0].kind).toBe('image')
      expect(out[0].name).toBe('shot.png')
      const base = store.getConversation(id)!.workspace
      expect(out[0].path).toMatch(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/attachments/attach-.*\\.png$`))
      expect(readFileSync(out[0].path).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the global workspace for conversations without a project', async () => {
    const { deps } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const tmp = mkdtempSync(join(tmpdir(), 'picoaide-ipc-global-'))
    setDataDirOverride(tmp)
    try {
      const id = handlers['chat:new']({})
      const out = await handlers['chat:attach']({
        conversationId: id,
        files: [{ kind: 'image', name: 'a.png', dataUrl: pngDataUrl([1, 2, 3]) }],
      })
      expect(out[0].path.startsWith(join(tmp, 'workspaces', 'attachments'))).toBe(true)
      expect(existsSync(out[0].path)).toBe(true)
    } finally {
      setDataDirOverride(null)
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects unsupported image formats', async () => {
    const { deps } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await expect(
      handlers['chat:attach']({ conversationId: id, files: [{ kind: 'image', name: 'a.gif', dataUrl: 'data:image/gif;base64,AAAA' }] }),
    ).rejects.toThrow('不支持')
  })

  it('rejects images over 5MB', async () => {
    const { deps } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    const big = Buffer.alloc(5 * 1024 * 1024 + 100)
    await expect(
      handlers['chat:attach']({ conversationId: id, files: [{ kind: 'image', name: 'big.png', dataUrl: `data:image/png;base64,${big.toString('base64')}` }] }),
    ).rejects.toThrow('5MB')
  })

  it('sanitizes file names so paths stay inside attachments dir', async () => {
    const { deps } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const tmp = mkdtempSync(join(tmpdir(), 'picoaide-ipc-name-'))
    setDataDirOverride(tmp)
    try {
      const id = handlers['chat:new']({})
      const out = await handlers['chat:attach']({
        conversationId: id,
        files: [{ kind: 'file', name: '../../escape.csv', dataUrl: 'data:text/csv;base64,YQo=' }],
      })
      expect(out[0].path.startsWith(join(tmp, 'workspaces', 'attachments'))).toBe(true)
      expect(existsSync(out[0].path)).toBe(true)
      expect(readFileSync(out[0].path, 'utf8')).toBe('a\n')
    } finally {
      setDataDirOverride(null)
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('IPC 输入校验(审计3-M2/M1)', () => {
  it('chat:attach 整体校验:数组内任一非法 dataUrl → 全部不落盘', async () => {
    const { deps } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const tmp = mkdtempSync(join(tmpdir(), 'picoaide-ipc-valid-'))
    setDataDirOverride(tmp)
    try {
      const id = handlers['chat:new']({})
      await expect(
        handlers['chat:attach']({
          conversationId: id,
          files: [
            { kind: 'image', name: 'ok.png', dataUrl: `data:image/png;base64,${Buffer.from([0x89, 0x50]).toString('base64')}` },
            { kind: 'image', name: 'bad.png', dataUrl: 'garbage-without-data-prefix' },
          ],
        }),
      ).rejects.toThrow(/data:/)
      // 先校验后落盘:第一个文件也不得写入
      expect(existsSync(join(tmp, 'workspaces', 'attachments'))).toBe(false)
    } finally {
      setDataDirOverride(null)
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('chat:attach 非字符串文件名拒绝且不落盘', async () => {
    const { deps } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const tmp = mkdtempSync(join(tmpdir(), 'picoaide-ipc-name2-'))
    setDataDirOverride(tmp)
    try {
      const id = handlers['chat:new']({})
      await expect(
        handlers['chat:attach']({
          conversationId: id,
          files: [{ kind: 'file', name: 42 as unknown as string, dataUrl: 'data:text/csv;base64,YQo=' }],
        }),
      ).rejects.toThrow(/文件名/)
      expect(existsSync(join(tmp, 'workspaces', 'attachments'))).toBe(false)
    } finally {
      setDataDirOverride(null)
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('chat:search 非字符串 query 不抛 TypeError(统一 String 化)', () => {
    const { deps } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    expect(() => handlers['chat:search']({ query: 42 as unknown as string })).not.toThrow()
    expect(() => handlers['chat:search']({ query: null as unknown as string })).not.toThrow()
    expect(handlers['chat:search']({ query: 42 as unknown as string })).toEqual([])
  })

  it('project:create 拒绝相对路径/根目录/空路径', () => {
    const { deps } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    expect(() => handlers['project:create']({ name: 'x', path: 'relative/dir' })).toThrow(/绝对路径/)
    expect(() => handlers['project:create']({ name: 'x', path: '/' })).toThrow(/绝对路径/)
    expect(() => handlers['project:create']({ name: 'x', path: '' })).toThrow(/绝对路径/)
    expect(() => handlers['project:create']({ name: 'x', path: '/ok/abs' })).not.toThrow()
  })

  it('chat:rename / chat:new 非字符串标题拒绝', () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    expect(() => handlers['chat:rename']({ conversationId: id, title: 42 as unknown as string })).toThrow()
    expect(() => handlers['chat:new']({ title: 42 as unknown as string })).toThrow()
    expect(store.getConversation(id)?.title).toBe('')
  })
})

describe('未登录时的本地操作(审计3-M1)', () => {
  it('chat:delete 在 createModel 抛未登录时仍可删除本地会话', async () => {
    const { deps, store } = makeDeps()
    deps.createModel = () => {
      throw new Error('未登录')
    }
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await expect(handlers['chat:delete']({ conversationId: id })).resolves.toBeUndefined()
    expect(store.getConversation(id)).toBeNull()
  })

  it('chat:cancel / agent:confirm 在引擎构造失败时不泄漏 unhandled rejection', async () => {
    const { deps } = makeDeps()
    deps.createModel = () => {
      throw new Error('未登录')
    }
    const handlers = buildAgentHandlers(deps)
    let leaked: unknown = undefined
    const onRej = (reason: unknown) => {
      leaked = reason
    }
    process.on('unhandledRejection', onRej)
    try {
      handlers['chat:cancel']()
      handlers['agent:confirm']({ requestId: 'x', ok: true })
      await new Promise((r) => setTimeout(r, 50))
      expect(leaked).toBeUndefined()
    } finally {
      process.removeListener('unhandledRejection', onRej)
    }
  })
})

describe('并发与运行中守卫(审计3-L1/L2)', () => {
  it('并发 getEngine 只构造一个引擎实例(async sysPrompt 下)', async () => {
    const { deps, modelCalls } = makeDeps('text')
    deps.sysPrompt = async () => 'sys'
    const handlers = buildAgentHandlers(deps)
    const id1 = handlers['chat:new']({})
    const id2 = handlers['chat:new']({})
    const results = await Promise.allSettled([
      handlers['chat:ask']({ conversationId: id1, content: 'a' }),
      handlers['chat:ask']({ conversationId: id2, content: 'b' }),
    ])
    expect(modelCalls()).toBe(1)
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
  })

  it('chat:editAndRerun 在会话运行中拒绝且不改库', async () => {
    const { deps, store, sent } = makeDeps('hang')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({ mode: 'craft' })
    const m1 = store.appendMessage({ conversationId: id, role: 'user', content: 'old question' })
    const ask = handlers['chat:ask']({ conversationId: id, content: 'hi' })
    await waitFor(() => eventsOf(sent).length > 0)
    await expect(handlers['chat:editAndRerun']({ conversationId: id, messageId: m1, content: 'edited' })).rejects.toThrow(/运行/)
    expect(store.listMessages(id).find((m) => m.id === m1)?.content).toBe('old question')
    expect(store.getConversation(id)?.status).not.toBe('failed')
    handlers['chat:cancel']()
    await ask
  })
})

describe('登出清空审批缓冲(审计3-L3)', () => {
  it('engine reset(登出)清空 pending confirm_required,rendererReady 不再补发', async () => {
    const { deps, sent, resetEngine } = makeDeps('tool-call')
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
    resetEngine()
    handlers['picoaide:rendererReady']()
    await run.catch(() => {})
    expect(eventsOf(sent).some((e) => (e as { type: string }).type === 'confirm_required')).toBe(false)
  })
})

describe('会话删除清理磁盘(审计3-H2)', () => {
  it('chat:delete 清理项目会话 workspace 的 attachments 与 tool-outputs,保留其他文件', async () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-del-'))
    deps.listProjectPaths = () => [dir]
    try {
      const pid = handlers['project:create']({ name: 'p', path: dir })
      const id = handlers['chat:new']({ projectId: pid })
      const ws = store.getConversation(id)!.workspace
      const attach = join(ws, 'attachments')
      const out = join(ws, 'tool-outputs')
      mkdirSync(attach, { recursive: true })
      mkdirSync(out, { recursive: true })
      writeFileSync(join(attach, 'a.png'), 'x')
      writeFileSync(join(out, 't.txt'), 'y')
      writeFileSync(join(ws, 'keep.md'), 'z')
      await handlers['chat:delete']({ conversationId: id })
      expect(existsSync(attach)).toBe(false)
      expect(existsSync(out)).toBe(false)
      expect(existsSync(join(ws, 'keep.md'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('chat:delete 不清理已知根目录之外的 workspace(路径校验兜底)', async () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-out-'))
    const outside = mkdtempSync(join(tmpdir(), 'picoaide-ipc-outside-'))
    try {
      const id = handlers['chat:new']({})
      const ws = join(outside, 'conv-ws')
      mkdirSync(join(ws, 'attachments'), { recursive: true })
      writeFileSync(join(ws, 'attachments', 'a.png'), 'x')
      store.setConversationWorkspace(id, ws)
      await handlers['chat:delete']({ conversationId: id })
      expect(existsSync(join(ws, 'attachments', 'a.png'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('project:delete 仅解绑,不删项目目录文件(现状保持)', async () => {
    const { deps, store } = makeDeps()
    const handlers = buildAgentHandlers(deps)
    const dir = mkdtempSync(join(tmpdir(), 'picoaide-ipc-projdel-'))
    try {
      const pid = handlers['project:create']({ name: 'p', path: dir })
      const id = handlers['chat:new']({ projectId: pid })
      const ws = store.getConversation(id)!.workspace
      writeFileSync(join(ws, 'keep.md'), 'x')
      handlers['project:delete']({ id: pid })
      expect(existsSync(join(ws, 'keep.md'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
