import { dialog, ipcMain, nativeTheme, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
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
import { isAllowed, resolveWorkspace } from './tools/paths'

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

// artifact 预览读取结果(artifact:read 返回;dataUrl 给 <img>,content 给 iframe/pre/Markdown)
export interface ArtifactReadResult {
  kind: 'html' | 'md' | 'text' | 'image' | 'other'
  content?: string
  dataUrl?: string
}

// 预览大小上限(与附件/工具结果阈值同量级):文本 1MB,图片 5MB
const PREVIEW_TEXT_LIMIT = 1024 * 1024
const PREVIEW_IMAGE_LIMIT = 5 * 1024 * 1024

const PREVIEW_TEXT_EXTS = new Set([
  'txt', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'css', 'scss', 'yml', 'yaml', 'xml',
  'csv', 'sh', 'bash', 'toml', 'ini', 'conf', 'log', 'sql', 'env', 'diff', 'rs', 'java', 'c', 'h', 'cpp',
])
const PREVIEW_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

// 预览种类按扩展名推断(html/md 走独立渲染,其余文本归 text,图片归 image)
export function artifactPreviewKind(path: string): ArtifactReadResult['kind'] {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md') return 'md'
  if (ext in PREVIEW_IMAGE_MIME) return 'image'
  if (PREVIEW_TEXT_EXTS.has(ext)) return 'text'
  return 'other'
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
  'artifact:read': (input: { path: string }) => ArtifactReadResult
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
  // 构造中占位(审计3-L1):async sysPrompt 下并发 getEngine 双重构造,构造完成再赋值
  let enginePromise: Promise<AgentEngine> | null = null
  const resetEngine = (): void => {
    // 登出/换账号/过期:必须先中止运行中的任务(循环、审批、网关调用),
    // 否则旧引擎继续用旧 token 跑并 emit 事件串到新会话 UI
    engine?.cancel()
    engine = null
    // 审批缓冲跨账号残留(审计3-L3):登出即清,renderer 下次就绪不得补发旧账号的确认框
    pending.length = 0
  }
  deps.registerEngineReset?.(resetEngine)
  // 基础系统提示(默认提示 + 技能指令),craft/plan 每次运行重新解析后追加 AGENTS.md
  const basePrompt = async (): Promise<string> =>
    typeof deps.sysPrompt === 'function' ? await deps.sysPrompt() : deps.sysPrompt
  const getEngine = async (): Promise<AgentEngine> => {
    // 双检(审计3-L1):构造期间并发调用复用同一 Promise,避免 sysPrompt 异步窗口内双重构造
    if (!engine && !enginePromise) {
      enginePromise = (async () => {
        const sysPrompt = typeof deps.sysPrompt === 'function' ? await deps.sysPrompt() : deps.sysPrompt
        return new AgentEngine(
          { model: deps.createModel(), sysPrompt, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
          {
            store: deps.store,
            emit: emitAgentEvent,
            addAllowedDir: deps.addAllowedDir,
          },
        )
      })()
      enginePromise.then(
        (e) => {
          engine = e
          enginePromise = null
        },
        () => {
          // 构造失败(如未登录):清空占位,下次调用重新尝试
          enginePromise = null
        },
      )
    }
    const e = engine ?? (await enginePromise)
    if (!e) throw new Error('引擎构造失败')
    return e
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
      if (input?.title !== undefined && typeof input.title !== 'string') throw new Error('无效的标题')
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
    'project:create': ({ name, path }) => {
      // 审计3-M2:非法路径会允许 chat:new 在任意位置建目录并进入 artifact:read 读取范围
      if (typeof path !== 'string' || path.trim().length === 0 || !isAbsolute(path) || path === '/') {
        throw new Error('项目路径必须为绝对路径,且不能是根目录')
      }
      if (typeof name !== 'string' || name.trim().length === 0) throw new Error('项目名不能为空')
      return deps.store.createProject({ name, path })
    },
    'project:delete': ({ id }) => deps.store.deleteProject(id),
    'conversation:moveProject': ({ conversationId, projectId }) => deps.store.setConversationProject(conversationId, projectId),
    // 附带文件落盘:粘贴图片/拖拽文件 → 会话 workspace 的 attachments/ 目录(无项目回退全局工作目录)。
    // 只落盘,不改消息;renderer 把返回路径以 [图片:]/[附带文件:] 引用并入 user 消息内容(DB 不存 base64)
    'chat:attach': async ({ conversationId, files }) => {
      const conv = deps.store.getConversation(conversationId)
      if (!conv) throw new Error('会话不存在')
      // 审计3-M2:整体先校验(类型/格式)再落盘,失败不留半写文件/垃圾字节
      if (!Array.isArray(files)) throw new Error('无效的附件参数')
      for (const f of files) {
        if (f.kind !== 'image' && f.kind !== 'file') throw new Error(`未知的附件类型:${String(f.kind)}`)
        if (typeof f.dataUrl !== 'string' || !f.dataUrl.startsWith('data:') || !f.dataUrl.includes(',')) {
          throw new Error('无效的附件数据(dataUrl 必须以 data: 开头且包含逗号)')
        }
        if (typeof f.name !== 'string') throw new Error('无效的附件文件名')
      }
      const base = resolveWorkspace(conv.workspace, workspaceDir())
      const dir = join(base, 'attachments')
      mkdirSync(dir, { recursive: true })
      const out: AttachResult[] = []
      files.forEach((f, i) => {
        const mime = f.dataUrl.slice(5, f.dataUrl.indexOf(';'))
        const bytes = dataUrlBytes(f.dataUrl)
        if (f.kind === 'image') {
          const err = validateImage(mime, bytes)
          if (err) throw new Error(err)
        } else if (bytes > MAX_FILE_BYTES) {
          throw new Error('附带文件超过 100MB 大小限制')
        }
        const buf = Buffer.from(f.dataUrl.slice(f.dataUrl.indexOf(',') + 1), 'base64')
        // 随机后缀:同毫秒 + 同索引的两次落盘(连续发送同型附件)不得互相覆盖
        const nonce = randomBytes(3).toString('hex')
        const storedName =
          f.kind === 'image'
            ? `attach-${Date.now()}-${i}-${nonce}.${imageExt(mime)}`
            : `${Date.now()}-${i}-${nonce}-${sanitizeFileName(f.name)}`
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
    'chat:cancel': () => {
      void getEngine().then((e) => e.cancel()).catch(() => {})
    },
    'agent:confirm': ({ requestId, ok }) => {
      void getEngine().then((e) => e.confirm(requestId, ok)).catch(() => {})
    },
    'chat:list': () => deps.store.listConversations(),
    // 启动扫描用:重启后 status IN ('running','executing') 的会话(架构设计 §3.3.1a)
    'chat:listRunning': () =>
      deps.store.listConversations().filter((c) => c.status === 'running' || c.status === 'executing'),
    'chat:messages': ({ conversationId }) => deps.store.listMessages(conversationId),
    // 消息编辑(chatbox 语义):改 user 消息内容 + 截断其后消息 + 重跑(模式决定是否带工具)
    'chat:editAndRerun': async ({ conversationId, messageId, content }) => {
      if (typeof content !== 'string') throw new Error('无效的消息内容')
      const conv = deps.store.getConversation(conversationId)
      const mode = conv?.mode ?? 'ask'
      // 审计3-L2:运行中先拒绝,避免先改库后占槽失败导致"库已改但没重跑"
      const e = await getEngine()
      if (e.runningConversation === conversationId) {
        throw new Error('会话正在运行,请先停止再编辑重跑')
      }
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
      // 删除运行中会话:先中止引擎,避免运行中的写库/FK 报错把结果吞掉;
      // 引擎不可用(未登录,createModel 抛错)时跳过,本地删除照常(审计3-M1)
      try {
        const e = await getEngine()
        if (e.runningConversation === conversationId) e.cancel()
      } catch {
        // 忽略:本地会话删除不依赖引擎
      }
      const conv = deps.store.getConversation(conversationId)
      // 审计3-H2:清理会话工作区的落盘子目录(attachments/tool-outputs);
      // 仅当 workspace 位于已知根目录(项目目录 + 全局工作目录)内,防误删(复用 isAllowed)
      if (conv?.workspace) {
        const roots = [...(deps.listProjectPaths?.() ?? []), workspaceDir()]
        if (isAllowed(conv.workspace, roots)) {
          for (const sub of ['attachments', 'tool-outputs']) {
            rmSync(join(conv.workspace, sub), { recursive: true, force: true })
          }
        }
      }
      deps.store.deleteConversation(conversationId)
    },
    'chat:rename': ({ conversationId, title }) => {
      if (typeof title !== 'string') throw new Error('无效的标题')
      deps.store.setConversationTitle(conversationId, title)
    },
    'chat:setStarred': ({ conversationId, starred }) => deps.store.setConversationStarred(conversationId, starred),
    'chat:setArchived': ({ conversationId, archived }) => deps.store.setConversationArchived(conversationId, archived),
    // 全局搜索(Cmd+P,chatbox SearchDialog 轻量版):标题 LIKE + 消息内容 LIKE,各取前 20 条
    'chat:search': ({ query }) => {
      // 审计3-M2:非字符串 query(损坏的 renderer 调用)统一 String 化,不抛 TypeError
      const q = typeof query === 'string' ? query : String(query ?? '')
      const trimmed = q.trim()
      if (!trimmed) return []
      const like = `%${trimmed}%`
      const byTitle = (deps.store.listConversations() as (ConversationRow & { starred?: number; archived?: number })[])
        .filter((c) => c.archived !== 1 && c.title.toLowerCase().includes(trimmed.toLowerCase()))
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
          const idx = m.content.toLowerCase().indexOf(trimmed.toLowerCase())
          if (idx >= 0) {
            const start = Math.max(0, idx - 30)
            const snippet = (start > 0 ? '…' : '') + m.content.slice(start, idx + trimmed.length + 30) + '…'
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
    // 产物预览读取(架构设计 §3.5):安全边界与 workspace:listFiles 同源——只读主进程组装的
    // 目录(全部项目目录 + 可访问目录),复用 isAllowed 路径校验,禁止新写安全逻辑;
    // 大小上限按种类(文本 1MB/图片 5MB),其他类型不读内容只报 kind
    'artifact:read': ({ path }) => {
      if (typeof path !== 'string' || path.length === 0) throw new Error('无效的产物路径')
      const dirs = [...(deps.listProjectPaths?.() ?? []), ...(deps.listAllowedDirs?.() ?? [])]
      if (!isAllowed(path, dirs)) throw new Error('路径不在允许目录内')
      if (!existsSync(path)) throw new Error('文件不存在或不可读')
      const kind = artifactPreviewKind(path)
      if (kind === 'image') {
        const st = statSync(path)
        if (st.size > PREVIEW_IMAGE_LIMIT) throw new Error('文件超过 5MB 预览大小限制')
        const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? 'png'
        const mime = PREVIEW_IMAGE_MIME[ext] ?? 'image/png'
        return { kind, dataUrl: `data:${mime};base64,${readFileSync(path).toString('base64')}` }
      }
      if (kind === 'html' || kind === 'md' || kind === 'text') {
        const st = statSync(path)
        if (st.size > PREVIEW_TEXT_LIMIT) throw new Error('文件超过 1MB 预览大小限制')
        return { kind, content: readFileSync(path, 'utf8') }
      }
      return { kind: 'other' }
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
