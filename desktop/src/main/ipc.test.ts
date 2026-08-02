import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { buildAgentHandlers, buildAuthHandlers, buildHandlers } from './ipc'
import type { AgentIpcDeps, AuthIpcDeps, StoreLike } from './ipc'
import type { AppendMessageInput } from './agent/engine'
import { AuthError } from './gateway/auth'
import type { Session } from './gateway/config'
import { clearCaches, getBootstrapCache, getCurrentSession } from './session_cache'

const USAGE = {
  inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
}

class FakeProvider {
  specificationVersion = 'v4' as const
  provider = 'fake'
  modelId = 'fake-model'

  constructor(private script: 'text' | 'throw' | 'hang' = 'text') {}

  async doGenerate() {
    throw new Error('not used')
  }

  async doStream() {
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
    const parts: any[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'answer from model' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: undefined } },
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

function makeStore(): StoreLike {
  const conversations: any[] = []
  const messages: any[] = []
  const artifacts: any[] = []
  const settings: Record<string, string> = {}
  let nextId = 1
  return {
    setConversationTitle: (id: number, title: string) => {
      const c = conversations.find((c) => c.id === id)
      if (c) c.title = title
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
    createConversation: (input: { title?: string; mode?: string } = {}): number => {
      const id = nextId++
      conversations.push({
        id,
        title: input.title ?? '',
        mode: input.mode ?? 'ask',
        status: 'done',
        model: '',
        workspace: '',
        created_at: '',
        updated_at: '',
      })
      return id
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
    appendMessage: (m: AppendMessageInput) => {
      messages.push({ ...m, id: nextId++ })
      return nextId
    },
  }
}

function makeDeps(script: 'text' | 'throw' | 'hang' = 'text') {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const store = makeStore()
  const deps: AgentIpcDeps = {
    store,
    sysPrompt: 'sys',
    createModel: () => new FakeProvider(script) as unknown as LanguageModel,
    getWindow: () => ({
      webContents: {
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    }),
  }
  return { sent, store, deps }
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

  it('emits error and marks the conversation failed when the model fails', async () => {
    const { deps, store, sent } = makeDeps('throw')
    const handlers = buildAgentHandlers(deps)
    const id = handlers['chat:new']({})
    await expect(handlers['chat:ask']({ conversationId: id, content: 'hi' })).rejects.toThrow()
    const events = eventsOf(sent)
    expect(events.filter((e) => (e as { type: string }).type === 'error')).toHaveLength(1)
    expect(store.getConversation(id)?.status).toBe('failed')
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
