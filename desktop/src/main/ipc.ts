import { ipcMain } from 'electron'
import { AgentEngine } from './agent/engine'
import type { StoreLike as EngineStore } from './agent/engine'
import type { AgentEvent } from './agent/events'
import type { LanguageModel } from 'ai'
import { ApiError, AuthError } from './gateway/auth'
import type { Session, BootstrapConfig } from './gateway/config'
import { establishSession, validateServerURL, clearCaches, setBootstrapCache, getCurrentSession } from './session_cache'

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
  'auth:login': (input: { serverURL: string; username: string; password: string }) => Promise<{
    session: Session & { persisted: boolean }
    bootstrap: BootstrapConfig
  }>
  'auth:loadSession': () => Promise<Session | null>
  'auth:logout': () => Promise<void>
  'auth:refreshBootstrap': () => Promise<BootstrapConfig>
  'auth:oidcLogin': (input: { serverURL: string }) => Promise<void>
}

export function buildHandlers(): Pick<IpcHandlers, 'picoaide:version'> {
  return {
    'picoaide:version': () => VERSION,
  }
}

export type ChatHandlers = Omit<IpcHandlers, 'auth:login' | 'auth:loadSession' | 'auth:logout' | 'auth:refreshBootstrap' | 'auth:oidcLogin'>

export function buildAgentHandlers(deps: AgentIpcDeps): ChatHandlers {
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

export interface AuthFlow {
  login(serverURL: string, username: string, password: string): Promise<Session>
  saveSession(s: Session): Promise<{ persisted: boolean }>
  loadSession(): Promise<Session | null>
  clearSession(): Promise<void>
}

export interface AuthIpcDeps {
  flow: AuthFlow
  getBootstrap: (s: Session) => Promise<{ config: BootstrapConfig; fellBack: boolean }>
  openExternal: (url: string) => Promise<void>
  onSessionEstablished: (session: Session) => void
  onSessionCleared: () => void
}

// ipc invoke 的错误跨进程只保留 message(自定义属性丢失),code 以 "code: message" 前缀编码
function authIpcError(code: string, message: string): ApiError {
  return new ApiError(code, `${code}: ${message}`)
}

function toIpcError(e: unknown): never {
  if (e instanceof AuthError) throw authIpcError(e.kind, e.message)
  if (e instanceof ApiError) throw e
  throw e instanceof Error ? e : new Error(String(e))
}

export function buildAuthHandlers(deps: AuthIpcDeps): Pick<IpcHandlers, 'auth:login' | 'auth:loadSession' | 'auth:logout' | 'auth:refreshBootstrap' | 'auth:oidcLogin'> {
  return {
    'auth:login': async ({ serverURL, username, password }) => {
      const url = validateServerURL(serverURL)
      if (!url.ok) throw authIpcError('INVALID_URL', url.error)
      try {
        return await establishSession(await deps.flow.login(url.url, username, password), deps)
      } catch (e) {
        toIpcError(e)
      }
    },
    'auth:loadSession': async () => {
      const session = await deps.flow.loadSession()
      if (!session) return null
      await establishSession(session, deps)
      return session
    },
    'auth:logout': async () => {
      await deps.flow.clearSession()
      clearCaches()
      deps.onSessionCleared()
    },
    'auth:refreshBootstrap': async () => {
      const session = getCurrentSession()
      if (!session) throw authIpcError('AUTH_REQUIRED', '未登录')
      const { config } = await deps.getBootstrap(session)
      setBootstrapCache(config)
      return config
    },
    'auth:oidcLogin': async ({ serverURL }) => {
      const url = validateServerURL(serverURL)
      if (!url.ok) throw authIpcError('INVALID_URL', url.error)
      await deps.openExternal(`${url.url}/api/auth/oidc/login`)
    },
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
