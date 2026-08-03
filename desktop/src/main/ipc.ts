import { dialog, ipcMain, nativeTheme, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { AgentEngine } from './agent/engine'
import type { GatedTool, StoreLike as EngineStore } from './agent/engine'
import type { AgentEvent } from './agent/events'
import type { LanguageModel } from 'ai'
import { ApiError, AuthError } from './gateway/auth'
import type { Session, BootstrapConfig } from './gateway/config'
import { establishSession, validateServerURL, clearCaches, setBootstrapCache, getCurrentSession } from './session_cache'
import { workspaceFor } from './store/projects'
import { listFilesRecursive } from './store/files'

export const VERSION = '0.2.0'

// 与 src/main/store/conversations.ts ConversationRow 结构一致(自包含,不 import store)
export interface ConversationRow {
  id: number
  title: string
  mode: string
  status: string
  model: string
  workspace: string
  project_id: number | null
  created_at: string
  updated_at: string
}

export interface ProjectRow {
  id: number
  name: string
  path: string
  created_at: string
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
  createConversation(input?: { title?: string; mode?: string; projectId?: number | null }): number
  listConversations(): ConversationRow[]
  getConversation(id: number): ConversationRow | null
  updateConversationStatus(id: number, status: string): void
  deleteConversation(id: number): void
  setConversationTitle(id: number, title: string): void
  setConversationWorkspace(id: number, workspace: string): void
  touchConversation(id: number): void
  // 覆写为完整行:chat:messages 需要读回全字段(MessageRow 是 DBMessage 的超集,兼容引擎)
  listMessages(conversationId: number): MessageRow[]
  addArtifact(a: { conversationId: number; path: string; type: string; size: number }): number
  listArtifacts(conversationId: number): ArtifactRow[]
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  getAllSettings(): Record<string, string>
  // 项目(迁移 0010)
  createProject(input: { name: string; path: string }): number
  listProjects(): ProjectRow[]
  getProject(id: number): ProjectRow | null
  deleteProject(id: number): void
  setConversationProject(conversationId: number, projectId: number | null): void
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
  sysPrompt: string | (() => string) | (() => Promise<string>)
  // 工具注册表(本地文件/终端/沙盒/屏幕/剪贴板/web/浏览器桥/远程知识库),index.ts 构建;craft 模式时调用
  getTools: (workspace?: string) => Promise<{ tools: Record<string, GatedTool>; highRiskTools: Set<string> }>
  getWindow: () => { webContents: { send(channel: string, payload: unknown): void } } | null
  // @ 文件选择器:枚举目录由主进程组装(可访问目录 + 全部项目目录),renderer 不可指定任意路径
  listAllowedDirs?: () => string[]
  listProjectPaths?: () => string[]
  // 越界引导:确认后将目录加入可访问目录(settings allowed_dirs)
  addAllowedDir?: (dir: string) => void
  // 引擎重置钩子:登出/换账号时由宿主(index.ts)调用,丢弃缓存的
  // AgentEngine(它持有旧会话的 model/token,跨登入残留会导致 401)
  registerEngineReset?: (reset: () => void) => void
  // session.defaultSession.fetch 注入(证书校验/TOFU 生效,架构设计 §3.3.7)
  fetch?: typeof fetch
}

export interface IpcHandlers {
  'picoaide:version': () => string
  'picoaide:rendererReady': () => void
  'theme:get': () => 'dark' | 'light'
  'chat:new': (input?: { title?: string; mode?: string; projectId?: number | null }) => number
  'chat:ask': (input: { conversationId: number; content: string }) => Promise<void>
  'chat:continue': (input: { conversationId: number }) => Promise<void>
  'chat:approvePlan': (input: { conversationId: number; ok: boolean }) => Promise<void>
  'chat:cancel': () => void
  'chat:list': () => ConversationRow[]
  'chat:listRunning': () => ConversationRow[]
  'chat:messages': (input: { conversationId: number }) => MessageRow[]
  'chat:messagesPaged': (input: { conversationId: number; offset: number; limit: number }) => MessageRow[]
  'chat:artifacts': (input: { conversationId: number }) => ArtifactRow[]
  'chat:delete': (input: { conversationId: number }) => void
  'agent:confirm': (input: { requestId: string; ok: boolean }) => void
  'artifact:showInFolder': (input: { path: string }) => void
  'project:list': () => ProjectRow[]
  'project:create': (input: { name: string; path: string }) => number
  'project:delete': (input: { id: number }) => void
  'conversation:moveProject': (input: { conversationId: number; projectId: number | null }) => void
  'workspace:listFiles': () => string[]
  'dialog:pickDirectory': () => Promise<string[]>
  'auth:login': (input: { serverURL: string; username: string; password: string }) => Promise<{
    session: Session & { persisted: boolean }
    bootstrap: BootstrapConfig
  }>
  'auth:loadSession': () => Promise<Session | null>
  'auth:logout': () => Promise<void>
  'auth:refreshBootstrap': () => Promise<BootstrapConfig>
  'auth:oidcLogin': (input: { serverURL: string }) => Promise<void>
}

export function buildHandlers(): Pick<IpcHandlers, 'picoaide:version' | 'theme:get'> {
  return {
    'picoaide:version': () => VERSION,
    'theme:get': () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
  }
}

export type ChatHandlers = Omit<IpcHandlers, 'auth:login' | 'auth:loadSession' | 'auth:logout' | 'auth:refreshBootstrap' | 'auth:oidcLogin'>

export function buildAgentHandlers(deps: AgentIpcDeps): ChatHandlers {
  // 引擎单例(持有 currentAbort/审批队列);模型经 createModel 惰性创建(登录后 token 就绪)
  let engine: AgentEngine | null = null
  const resetEngine = (): void => {
    engine = null
  }
  deps.registerEngineReset?.(resetEngine)
  const getEngine = async (): Promise<AgentEngine> => {
    if (!engine) {
      const sysPrompt = typeof deps.sysPrompt === 'function' ? await deps.sysPrompt() : deps.sysPrompt
      engine = new AgentEngine(
        { model: deps.createModel(), sysPrompt, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
        {
          store: deps.store,
          emit: emitAgentEvent,
          addAllowedDir: deps.addAllowedDir,
        },
      )
    }
    return engine
  }
  // confirm_required 事件缓冲:renderer 未就绪(未订阅 agent:event)时暂存,rendererReady 后补发(防弹窗丢失)
  let rendererReady = false
  const pending: AgentEvent[] = []
  const emitAgentEvent = (ev: AgentEvent): void => {
    if (ev.type === 'confirm_required' && !rendererReady) {
      pending.push(ev)
      return
    }
    deps.getWindow()?.webContents.send('agent:event', ev)
  }
  const flushPending = (): void => {
    while (pending.length > 0) {
      const ev = pending.shift()
      if (ev) deps.getWindow()?.webContents.send('agent:event', ev)
    }
  }
  return {
    'picoaide:version': () => VERSION,
    'theme:get': () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    'picoaide:rendererReady': () => {
      rendererReady = true
      flushPending()
    },
    'chat:new': (input) => {
      const projectId = input?.projectId ?? null
      const id = deps.store.createConversation({ title: input?.title, mode: input?.mode, projectId })
      if (projectId !== null) {
        const project = deps.store.getProject(projectId)
        if (project) {
          const ws = workspaceFor(project.path, id)
          mkdirSync(ws, { recursive: true })
          deps.store.setConversationWorkspace(id, ws)
        }
      }
      return id
    },
    'project:list': () => deps.store.listProjects(),
    'project:create': ({ name, path }) => deps.store.createProject({ name, path }),
    'project:delete': ({ id }) => deps.store.deleteProject(id),
    'conversation:moveProject': ({ conversationId, projectId }) => deps.store.setConversationProject(conversationId, projectId),
    'workspace:listFiles': () => {
      // 安全边界:只枚举主进程组装的目录(全部项目目录 + 可访问目录),renderer 不可指定任意路径
      const projectDirs = deps.listProjectPaths?.() ?? []
      const allowed = deps.listAllowedDirs?.() ?? []
      return listFilesRecursive([...projectDirs, ...allowed])
    },
    'dialog:pickDirectory': async () => {
      const win = deps.getWindow()
      if (!win) return []
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? [] : result.filePaths
    },
    'chat:ask': async ({ conversationId, content }) => {
      const mode = deps.store.getConversation(conversationId)?.mode ?? 'ask'
      if (mode === 'craft') {
        const { tools, highRiskTools } = await deps.getTools(deps.store.getConversation(conversationId)?.workspace)
        await (await getEngine()).craft({ conversationId, content, tools, highRiskTools })
      } else if (mode === 'plan') {
        await (await getEngine()).plan({ conversationId, content })
      } else {
        await (await getEngine()).ask({ conversationId, content })
      }
    },
    // 重跑恢复(架构设计 §3.3.1a):ask 会话无工具重跑;craft/plan 带全量工具
    'chat:continue': async ({ conversationId }) => {
      const mode = deps.store.getConversation(conversationId)?.mode ?? 'ask'
      if (mode === 'ask') {
        await (await getEngine()).continueConversation({ conversationId })
      } else {
        const { tools, highRiskTools } = await deps.getTools(deps.store.getConversation(conversationId)?.workspace)
        await (await getEngine()).continueConversation({ conversationId, tools, highRiskTools })
      }
    },
    // Plan 确认(架构设计 §3.3.4):ok → 同会话第二轮带 tools 执行;!ok → rejected
    'chat:approvePlan': async ({ conversationId, ok }) => {
      if (ok) {
        const { tools, highRiskTools } = await deps.getTools(deps.store.getConversation(conversationId)?.workspace)
        await (await getEngine()).approvePlan({ conversationId, ok, tools, highRiskTools })
      } else {
        await (await getEngine()).approvePlan({ conversationId, ok })
      }
    },
    'chat:cancel': () => { void getEngine().then((e) => e.cancel()) },
    'agent:confirm': ({ requestId, ok }) => { void getEngine().then((e) => e.confirm(requestId, ok)) },
    'chat:list': () => deps.store.listConversations(),
    // 启动扫描用:重启后 status IN ('running','executing') 的会话(架构设计 §3.3.1a)
    'chat:listRunning': () =>
      deps.store.listConversations().filter((c) => c.status === 'running' || c.status === 'executing'),
    'chat:messages': ({ conversationId }) => deps.store.listMessages(conversationId),
    // 分页(4.4):offset 从最新消息往前数,offset=0 返回最新 limit 条
    'chat:messagesPaged': ({ conversationId, offset, limit }) => {
      const all = deps.store.listMessages(conversationId)
      const end = all.length - offset
      const start = Math.max(0, end - limit)
      return all.slice(start, end)
    },
    'chat:artifacts': ({ conversationId }) => deps.store.listArtifacts(conversationId),
    'chat:delete': ({ conversationId }) => deps.store.deleteConversation(conversationId),
    'artifact:showInFolder': ({ path }) => {
      if (typeof path === 'string' && path.length > 0) shell.showItemInFolder(path)
    },
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
      const url = validateServerURL(serverURL ?? '')
      if (!url.ok) throw authIpcError('INVALID_URL', url.error)
      await deps.openExternal(`${url.url}/api/auth/oidc/login`)
    },
  }
}

export type IpcMainLike = { handle(channel: string, listener: (...args: any[]) => unknown): void }

// registerIpcHandlers wires all handlers onto ipcMain (ipc 可注入,便于测试/隔离).
// 注意:ipcMain.handle 的回调签名是 (event, ...args)——必须剥离事件对象,
// 否则 handler 收到的第一个参数是 IpcMainInvokeEvent 而非调用方 payload。
export function registerIpcHandlers(
  handlers: Record<string, any> = buildHandlers(),
  ipc: IpcMainLike = ipcMain,
): void {
  for (const [channel, fn] of Object.entries(handlers)) {
    ipc.handle(channel, (_event: unknown, ...args: unknown[]) => fn(...args))
  }
}
