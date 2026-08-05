import { dialog, ipcMain, nativeTheme, shell } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentEngine } from './agent/engine'
import type { GatedTool, StoreLike as EngineStore } from './agent/engine'
import type { AgentEvent } from './agent/events'
import type { LanguageModel } from 'ai'
import { ApiError, AuthError } from './gateway/auth'
import type { Session, BootstrapConfig } from './gateway/config'
import { establishSession, validateServerURL, clearCaches, setBootstrapCache, getCurrentSession } from './session_cache'
import { workspaceFor } from './store/projects'
import { listFilesRecursive } from './store/files'
import { updateMessageContent, deleteMessagesAfter } from './store/messages'
import { dataUrlBytes, imageExt, validateImage, MAX_FILE_BYTES } from '../shared/attachments'
import type { AttachmentInput, AttachResult } from '../shared/attachments'
import { workspaceDir } from './paths'
import { resolveWorkspace } from './tools/paths'

// 与 src/main/store/conversations.ts ConversationRow 结构一致(自包含,不 import store)
export interface ConversationRow {
  id: number
  title: string
  mode: string
  status: string
  model: string
  workspace: string
  project_id: number | null
  starred: number
  archived: number
  created_at: string
  updated_at: string
  preview?: string | null
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
  setConversationStarred(id: number, starred: boolean): void
  setConversationArchived(id: number, archived: boolean): void
  setConversationWorkspace(id: number, workspace: string): void
  // 覆写为完整行:chat:messages 需要读回全字段(MessageRow 是 DBMessage 的超集,兼容引擎)
  listMessages(conversationId: number): MessageRow[]
  updateMessageContent(id: number, content: string): void
  deleteMessagesAfter(conversationId: number, id: number): void
  deleteMessage(id: number): void
  addArtifact(a: { conversationId: number; path: string; type: string; size: number }): number
  listArtifacts(conversationId: number): ArtifactRow[]
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
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

// AGENTS.md 注入上限:单文件最长 4096 字符(防超大指令文件撑爆上下文)
const MAX_PROJECT_INSTRUCTION_CHARS = 4096

// 会话 workspace 的 AGENTS.md 注入系统提示(每次 craft/plan 调用重新读取,工作区文件可能变化);
// workspace 为空(无项目会话,无法确定目录)时跳过,不误读全局目录之外的指令文件
export function loadProjectInstructions(workspace: string | undefined): string {
  if (!workspace || workspace.trim().length === 0) return ''
  let content: string
  try {
    content = readFileSync(join(workspace, 'AGENTS.md'), 'utf8')
  } catch {
    return ''
  }
  if (content.length > MAX_PROJECT_INSTRUCTION_CHARS) {
    content = content.slice(0, MAX_PROJECT_INSTRUCTION_CHARS) + '\n…(截断:AGENTS.md 超过 4096 字符)'
  }
  return '\n\n## 项目指令(AGENTS.md)\n' + content
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
  // 自动标题(后台 fire-and-forget):chat:ask 引擎完成且会话标题为空时生成
  autoTitle?: (input: { conversationId: number }) => Promise<void>
  // 越界引导:确认后将目录加入可访问目录(settings allowed_dirs)
  addAllowedDir?: (dir: string) => void
  // 引擎重置钩子:登出/换账号时由宿主(index.ts)调用,丢弃缓存的
  // AgentEngine(它持有旧会话的 model/token,跨登入残留会导致 401)
  registerEngineReset?: (reset: () => void) => void
  // session.defaultSession.fetch 注入(证书校验/TOFU 生效,架构设计 §3.3.7)
  fetch?: typeof fetch
}

export interface IpcHandlers {
  'picoaide:rendererReady': () => void
  'theme:get': () => 'dark' | 'light'
  'chat:new': (input?: { title?: string; mode?: string; projectId?: number | null }) => number
  'chat:ask': (input: { conversationId: number; content: string; mode?: string }) => Promise<void>
  'chat:attach': (input: { conversationId: number; files: AttachmentInput[] }) => Promise<AttachResult[]>
  'chat:queue': (input: { conversationId: number; content: string }) => Promise<boolean>
  'chat:continue': (input: { conversationId: number }) => Promise<void>
  'chat:approvePlan': (input: { conversationId: number; ok: boolean }) => Promise<void>
  'chat:cancel': () => void
  'chat:list': () => ConversationRow[]
  'chat:listRunning': () => ConversationRow[]
  'chat:messages': (input: { conversationId: number }) => MessageRow[]
  'chat:messagesPaged': (input: { conversationId: number; offset: number; limit: number }) => MessageRow[]
  'chat:editAndRerun': (input: { conversationId: number; messageId: number; content: string }) => Promise<void>
  'chat:deleteMessage': (input: { messageId: number }) => void
  'chat:artifacts': (input: { conversationId: number }) => ArtifactRow[]
  'chat:delete': (input: { conversationId: number }) => void
  'chat:rename': (input: { conversationId: number; title: string }) => void
  'chat:setStarred': (input: { conversationId: number; starred: boolean }) => void
  'chat:setArchived': (input: { conversationId: number; archived: boolean }) => void
  'chat:export': (input: { conversationId: number }) => string
  'chat:search': (input: { query: string }) => { conversationId: number; title: string; snippet: string }[]
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

export function buildHandlers(): Pick<IpcHandlers, 'theme:get'> {
  return {
    'theme:get': () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
  }
}

export type ChatHandlers = Omit<IpcHandlers, 'auth:login' | 'auth:loadSession' | 'auth:logout' | 'auth:refreshBootstrap' | 'auth:oidcLogin' | 'theme:get'>

export function buildAgentHandlers(deps: AgentIpcDeps): ChatHandlers {
  // 引擎单例(持有 currentAbort/审批队列);模型经 createModel 惰性创建(登录后 token 就绪)
  let engine: AgentEngine | null = null
  const resetEngine = (): void => {
    // 登出/换账号/过期:必须先中止运行中的任务(循环、审批、网关调用),
    // 否则旧引擎继续用旧 token 跑并 emit 事件串到新会话 UI
    engine?.cancel()
    engine = null
  }
  deps.registerEngineReset?.(resetEngine)
  // 基础系统提示(默认提示 + 技能指令),craft/plan 每次运行重新解析后追加 AGENTS.md
  const basePrompt = async (): Promise<string> =>
    typeof deps.sysPrompt === 'function' ? await deps.sysPrompt() : deps.sysPrompt
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
    // 附带文件落盘:粘贴图片/拖拽文件 → 会话 workspace 的 attachments/ 目录(无项目回退全局工作目录)。
    // 只落盘,不改消息;renderer 把返回路径以 [图片:]/[附带文件:] 引用并入 user 消息内容(DB 不存 base64)
    'chat:attach': async ({ conversationId, files }) => {
      const conv = deps.store.getConversation(conversationId)
      if (!conv) throw new Error('会话不存在')
      const base = resolveWorkspace(conv.workspace, workspaceDir())
      const dir = join(base, 'attachments')
      mkdirSync(dir, { recursive: true })
      const out: AttachResult[] = []
      files.forEach((f, i) => {
        if (f.kind !== 'image' && f.kind !== 'file') throw new Error(`未知的附件类型:${String(f.kind)}`)
        const mime = f.dataUrl.slice(5, f.dataUrl.indexOf(';'))
        const bytes = dataUrlBytes(f.dataUrl)
        if (f.kind === 'image') {
          const err = validateImage(mime, bytes)
          if (err) throw new Error(err)
        } else if (bytes > MAX_FILE_BYTES) {
          throw new Error('附带文件超过 100MB 大小限制')
        }
        const buf = Buffer.from(f.dataUrl.slice(f.dataUrl.indexOf(',') + 1), 'base64')
        const storedName =
          f.kind === 'image'
            ? `attach-${Date.now()}-${i}.${imageExt(mime)}`
            : `${Date.now()}-${i}-${sanitizeFileName(f.name)}`
        const path = join(dir, storedName)
        writeFileSync(path, buf)
        out.push({ kind: f.kind, name: f.name, path })
      })
      return out
    },
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
    'chat:ask': async ({ conversationId, content, mode: modeHint }) => {
      const conv = deps.store.getConversation(conversationId)
      // 分派用"本次发送时按钮选择的模式"(modeHint);按钮只是 UI 状态,会话创建时定的 mode
      // 会误导用户(在 ask 会话点"执行"仍走 ask 无工具)。缺省回退会话 mode。
      const mode = modeHint ?? conv?.mode ?? 'craft'
      if (mode === 'ask') {
        // ask 会话(旧 UI/历史):纯聊天无工具单步(契约:ask = 无工具),不误配全量工具
        await (await getEngine()).ask({ conversationId, content })
      } else {
        const { tools, highRiskTools } = await deps.getTools(conv?.workspace)
        // 每次运行重新组装:基础提示(默认+技能指令)+ 会话 workspace 的 AGENTS.md(文件可能中途变化)
        const sysPrompt = (await basePrompt()) + loadProjectInstructions(conv?.workspace)
        if (mode === 'plan') {
          // 计划(只读):引擎内部过滤为只读工具集,多步调研出计划
          await (await getEngine()).plan({ conversationId, content, tools, highRiskTools, sysPrompt })
        } else {
          await (await getEngine()).craft({ conversationId, content, tools, highRiskTools, sysPrompt })
        }
      }
      // 自动标题:后台生成,不阻塞对话完成;内部处理兜底与去重
      if (deps.autoTitle) void deps.autoTitle({ conversationId })
    },
    // 回复中排队:当前步骤完成后自动处理(引擎单运行守卫内队列)
    'chat:queue': async ({ conversationId, content }) => (await getEngine()).queueMessage(conversationId, content),
    // 重跑恢复(架构设计 §3.3.1a):ask 会话无工具重跑;craft/plan 带全量工具
    'chat:continue': async ({ conversationId }) => {
      const conv = deps.store.getConversation(conversationId)
      const mode = conv?.mode ?? 'ask'
      if (mode === 'ask') {
        await (await getEngine()).continueConversation({ conversationId })
      } else {
        const { tools, highRiskTools } = await deps.getTools(conv?.workspace)
        const sysPrompt = (await basePrompt()) + loadProjectInstructions(conv?.workspace)
        await (await getEngine()).continueConversation({ conversationId, tools, highRiskTools, sysPrompt })
      }
    },
    // Plan 确认(架构设计 §3.3.4):ok → 同会话第二轮带 tools 执行;!ok → rejected
    'chat:approvePlan': async ({ conversationId, ok }) => {
      if (ok) {
        const conv = deps.store.getConversation(conversationId)
        const { tools, highRiskTools } = await deps.getTools(conv?.workspace)
        const sysPrompt = (await basePrompt()) + loadProjectInstructions(conv?.workspace)
        await (await getEngine()).approvePlan({ conversationId, ok, tools, highRiskTools, sysPrompt })
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
    // 消息编辑(chatbox 语义):改 user 消息内容 + 截断其后消息 + 重跑(模式决定是否带工具)
    'chat:editAndRerun': async ({ conversationId, messageId, content }) => {
      const conv = deps.store.getConversation(conversationId)
      const mode = conv?.mode ?? 'ask'
      deps.store.updateMessageContent(messageId, content)
      deps.store.deleteMessagesAfter(conversationId, messageId)
      // 引擎仅允许 running/executing/planning/failed 状态重跑,编辑场景先把 done 置为 failed
      deps.store.updateConversationStatus(conversationId, 'failed')
      if (mode === 'ask') {
        await (await getEngine()).continueConversation({ conversationId })
      } else {
        const { tools, highRiskTools } = await deps.getTools(conv?.workspace)
        const sysPrompt = (await basePrompt()) + loadProjectInstructions(conv?.workspace)
        await (await getEngine()).continueConversation({ conversationId, tools, highRiskTools, sysPrompt })
      }
      if (deps.autoTitle) void deps.autoTitle({ conversationId })
    },
    'chat:deleteMessage': ({ messageId }) => deps.store.deleteMessage(messageId),
    // 分页(4.4):offset 从最新消息往前数,offset=0 返回最新 limit 条;参数显式夹取防越界
    'chat:messagesPaged': ({ conversationId, offset, limit }) => {
      const safeOffset = Math.max(0, Math.floor(offset))
      const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)))
      const all = deps.store.listMessages(conversationId)
      const end = all.length - safeOffset
      const start = Math.max(0, end - safeLimit)
      return all.slice(start, Math.max(start, end))
    },
    'chat:artifacts': ({ conversationId }) => deps.store.listArtifacts(conversationId),
    'chat:delete': async ({ conversationId }) => {
      // 删除运行中会话:先中止引擎,避免运行中的写库/FK 报错把结果吞掉
      const e = await getEngine()
      if (e.runningConversation === conversationId) e.cancel()
      deps.store.deleteConversation(conversationId)
    },
    'chat:rename': ({ conversationId, title }) => deps.store.setConversationTitle(conversationId, title),
    'chat:setStarred': ({ conversationId, starred }) => deps.store.setConversationStarred(conversationId, starred),
    'chat:setArchived': ({ conversationId, archived }) => deps.store.setConversationArchived(conversationId, archived),
    // 全局搜索(Cmd+P,chatbox SearchDialog 轻量版):标题 LIKE + 消息内容 LIKE,各取前 20 条
    'chat:search': ({ query }) => {
      const q = query.trim()
      if (!q) return []
      const like = `%${q}%`
      const byTitle = (deps.store.listConversations() as (ConversationRow & { starred?: number; archived?: number })[])
        .filter((c) => c.archived !== 1 && c.title.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 20)
        .map((c) => ({ conversationId: c.id, title: c.title || '新会话', snippet: '' }))
      const byMsg: { conversationId: number; title: string; snippet: string }[] = []
      const convs = deps.store.listConversations()
      let scanned = 0
      const MAX_SCAN = 20000 // 扫描上限:大库全表 LIKE 会卡主进程,达到即截断返回
      for (const c of convs) {
        const rows = deps.store.listMessages(c.id)
        for (const m of rows) {
          if (++scanned > MAX_SCAN) return [...byTitle, ...byMsg]
          if (m.role !== 'user' && m.role !== 'assistant') continue
          const idx = m.content.toLowerCase().indexOf(q.toLowerCase())
          if (idx >= 0) {
            const start = Math.max(0, idx - 30)
            const snippet = (start > 0 ? '…' : '') + m.content.slice(start, idx + q.length + 30) + '…'
            byMsg.push({ conversationId: c.id, title: c.title || '未命名会话', snippet })
            if (byMsg.length >= 20) break
          }
        }
        if (byMsg.length >= 20) break
      }
      return [...byTitle, ...byMsg]
    },
    // 导出会话为 Markdown(chatbox ExportChat 轻量版:文本导出,复制到剪贴板)
    'chat:export': ({ conversationId }) => {
      const conv = deps.store.getConversation(conversationId)
      if (!conv) return ''
      const msgs = deps.store.listMessages(conversationId)
      const title = conv.title || '未命名会话'
      const lines = [`# ${title}`, '', `> 导出时间:${new Date().toLocaleString()}`, '']
      for (const m of msgs) {
        if (m.role === 'user') lines.push(`## 我`, '', m.content, '')
        else if (m.role === 'assistant') lines.push(`## PicoAide`, '', m.content, '')
        else if (m.role === 'tool') lines.push(`> 工具调用:${m.tool_name}`, '')
      }
      return lines.join('\n')
    },
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

// 附件文件名清洗:去掉路径分隔符/控制字符/前导点(防目录穿越与异常名),空名兜底
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, '_').replace(/^\.+/, '')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file'
}

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
