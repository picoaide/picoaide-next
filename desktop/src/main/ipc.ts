import { ipcMain } from 'electron'
import { AgentEngine } from './agent/engine'
import type { StoreLike as EngineStore } from './agent/engine'
import type { AgentEvent } from './agent/events'
import type { LanguageModel } from 'ai'

export const VERSION = '0.2.0'

// 与 src/main/store/conversations.ts ConversationRow 结构一致(自包含,不 import store)
export interface ConversationRow {
  id: number
  title: string
  mode: string
  status: string
  model: string
  workspace: string
  created_at: string
  updated_at: string
}

// 与 src/main/store/messages.ts MessageRow 结构一致(自包含,不 import store)
export interface MessageRow {
  id: number
  conversation_id: number
  role: string
  content: string
  reasoning: string
  tool_calls: string
  tool_call_id: string
  tool_name: string
  is_error: number
  created_at: string
}

// 引擎 StoreLike + 会话级操作(index.ts 用 store 模块函数包一层即可,零 cast)
export interface StoreLike extends EngineStore {
  createConversation(input?: { title?: string; mode?: string }): number
  listConversations(): ConversationRow[]
  getConversation(id: number): ConversationRow | null
  updateConversationStatus(id: number, status: string): void
  deleteConversation(id: number): void
  setConversationTitle(id: number, title: string): void
  touchConversation(id: number): void
  // 覆写为完整行:chat:messages 需要读回全字段(MessageRow 是 DBMessage 的超集,兼容引擎)
  listMessages(conversationId: number): MessageRow[]
  addArtifact(a: { conversationId: number; path: string; type: string; size: number }): number
  listArtifacts(conversationId: number): ArtifactRow[]
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  getAllSettings(): Record<string, string>
}

export interface ArtifactRow {
  id: number
  conversation_id: number
  path: string
  type: string
  size: number
  created_at: string
}

export interface AgentIpcDeps {
  store: StoreLike
  createModel: () => LanguageModel
  sysPrompt: string
  getWindow: () => { webContents: { send(channel: string, payload: unknown): void } } | null
}

export interface IpcHandlers {
  'picoaide:version': () => string
  'chat:new': (input?: { title?: string; mode?: string }) => number
  'chat:ask': (input: { conversationId: number; content: string }) => Promise<void>
  'chat:cancel': () => void
  'chat:list': () => ConversationRow[]
  'chat:messages': (input: { conversationId: number }) => MessageRow[]
  'chat:delete': (input: { conversationId: number }) => void
}

export function buildHandlers(): Pick<IpcHandlers, 'picoaide:version'> {
  return {
    'picoaide:version': () => VERSION,
  }
}

export function buildAgentHandlers(deps: AgentIpcDeps): IpcHandlers {
  // 引擎单例(持有 currentAbort/审批队列);模型经 createModel 惰性创建(登录后 token 就绪)
  let engine: AgentEngine | null = null
  const getEngine = (): AgentEngine => {
    if (!engine) {
      engine = new AgentEngine(
        { model: deps.createModel(), sysPrompt: deps.sysPrompt },
        {
          store: deps.store,
          emit: (ev: AgentEvent) => deps.getWindow()?.webContents.send('agent:event', ev),
        },
      )
    }
    return engine
  }
  return {
    'picoaide:version': () => VERSION,
    'chat:new': (input) => deps.store.createConversation(input),
    'chat:ask': async ({ conversationId, content }) => {
      await getEngine().ask({ conversationId, content })
    },
    'chat:cancel': () => getEngine().cancel(),
    'chat:list': () => deps.store.listConversations(),
    'chat:messages': ({ conversationId }) => deps.store.listMessages(conversationId),
    'chat:delete': ({ conversationId }) => deps.store.deleteConversation(conversationId),
  }
}

export type IpcMainLike = { handle(channel: string, listener: (...args: any[]) => unknown): void }

// registerIpcHandlers wires all handlers onto ipcMain (ipc 可注入,便于测试/隔离).
export function registerIpcHandlers(
  handlers: Record<string, any> = buildHandlers(),
  ipc: IpcMainLike = ipcMain,
): void {
  for (const [channel, fn] of Object.entries(handlers)) {
    ipc.handle(channel, fn)
  }
}
