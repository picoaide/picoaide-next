import { describe, expect, it } from 'vitest'
import type { LanguageModel } from 'ai'
import { buildAgentHandlers, buildHandlers } from './ipc'
import type { AgentIpcDeps, StoreLike } from './ipc'
import type { AppendMessageInput } from './agent/engine'

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

describe('chat:ask', () => {
  it('persists user+assistant messages and streams events to the window', async () => {
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
