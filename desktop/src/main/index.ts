import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { tool } from 'ai'
import { z } from 'zod'
import type { Tool } from 'ai'
import { registerIpcHandlers, buildHandlers, buildAgentHandlers, buildAuthHandlers } from './ipc'
import type { AuthIpcDeps, StoreLike } from './ipc'
import { openDb } from './store/db'
import { migrate } from './store/migrations'
import {
  createConversation, listConversations, getConversation,
  updateConversationStatus, deleteConversation, setConversationTitle, setConversationWorkspace, touchConversation,
  setConversationStarred, setConversationArchived,
} from './store/conversations'
import { createProject, listProjects, getProject, deleteProject, setConversationProject } from './store/projects'
import { listMessages, appendMessage, updateMessageContent, deleteMessagesAfter, deleteMessage } from './store/messages'
import { addArtifact, listArtifacts } from './store/artifacts'
import { getSetting, setSetting, getAllSettings } from './store/settings'
import { dataDir, dbPath, workspaceDir } from './paths'
import { installCertificateVerification } from './gateway/tls'
import { createGatewayModel as makeGatewayModel } from './agent/provider'
import { createKbTools } from './agent/engine'
import type { GatedTool } from './agent/engine'
import { createFileTools, HIGH_RISK_TOOLS as FILES_HIGH_RISK } from './tools/filesystem'
import { commandExec, needsApprovalFor } from './tools/terminal'
import { createSandboxTool, getSandbox } from './tools/sandbox'
import { screenCaptureTool, HIGH_RISK_TOOLS as SCREEN_HIGH_RISK } from './tools/screen'
import { clipboardReadTool, clipboardWriteTool, HIGH_RISK_TOOLS as CLIPBOARD_HIGH_RISK } from './tools/clipboard'
import { createWebTools } from './tools/web'
import { getAllowedDirsFromSettings, resolveAllowedDirs, resolveWorkspace } from './tools/paths'
import { initOperationLog, logOperation } from './tools/operation-log'
import { login, saveSession, loadSession, clearSession, gatewayFetch } from './gateway/auth'
import { generateTitle, fallbackTitle } from './agent/title'
import { getBootstrap } from './gateway/bootstrap'
import { createHealthPoller } from './gateway/health'
import type { Session } from './gateway/config'
import { establishSession, clearCaches, getBootstrapCache, getCurrentSession, setBootstrapCache } from './session_cache'
import { clearCredentials as clearMcpCredentials } from './mcp/installer'
import { buildPluginHandlers } from './plugin_ipc'

let mainWindow: BrowserWindow | null = null
let poller: ReturnType<typeof createHealthPoller> | null = null

// 去掉客户端框架菜单栏(File/Edit/View/Window/Help 等,用户反馈干扰):
// macOS 系统菜单栏保留最小应用菜单(关于/设置/退出 + 编辑快捷键,符合 HIG,Cmd+Q/+/N 不失效);
// Windows/Linux 应用菜单移除 + 窗口菜单栏隐藏(Alt 不可呼出,界面完全无菜单栏)
function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const send = (command: string): void => {
    mainWindow?.webContents.send('menu:command', command)
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Cmd+,', click: () => send('settings') },
        { label: '新建会话', accelerator: 'Cmd+N', click: () => send('new-chat') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      // 文本编辑快捷键(复制/粘贴/全选)在无菜单时失效,保留编辑菜单
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// 最近一次成功登录的服务器地址(设置表持久化),OIDC 深链回跳时用
let lastServerURL: string | null = null
// 自动标题 in-flight 锁(同会话并发去重,防止 ask+editAndRerun 双网关调用)
const titleInflight = new Set<number>()
// 启动扫描未完成任务用(架构设计 §3.3.1a):whenReady 内注入 store
let appStore: StoreLike | null = null
// 引擎重置钩子:登出/换账号时丢弃缓存的 AgentEngine(持有旧会话 model/token)
let resetAgentEngine: () => void = () => {}
// 当前活跃工具注册表的可访问目录数组(addAllowedDir 就地更新,越界授权后自动重试立即生效)
let activeAllowedDirs: string[] | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    // Windows/Linux:窗口不显示菜单栏(菜单已整体移除)
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 重启恢复(架构设计 §3.3.1a):扫描 status IN ('running','executing') 的会话,推送给 renderer 提示继续
  mainWindow.webContents.on('did-finish-load', () => {
    const running = appStore?.listConversations().filter((c) => c.status === 'running' || c.status === 'executing')
    if (running && running.length > 0) mainWindow?.webContents.send('chat:interrupted', running)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

// 健康轮询:登录/恢复会话后启动,登出或令牌过期后停止
function startPoller(session: Session) {
  stopPoller()
  poller = createHealthPoller(session, { intervalMs: 15_000 })
  poller.start((status) => {
    if (status === 'auth_expired') {
      stopPoller()
      clearCaches()
      void clearSession()
      // token 过期:中止旧引擎(不再用失效 token 重试),并清 MCP 凭证内存(与显式登出一致)
      resetAgentEngine()
      clearMcpCredentials()
    }
    mainWindow?.webContents.send('connection:status', status)
  })
}

function stopPoller() {
  poller?.stop()
  poller = null
}

// 浏览器桥工具(CDP 插件)可能尚未落地:安全动态导入,文件缺失时静默降级为空注册表
async function loadBrowserTools(): Promise<{ tools: Record<string, Tool>; highRisk: string[] }> {
  try {
    const mod = (await import('./tools/browser')) as {
      createBrowserTools?: () => Record<string, Tool>
      browserTools?: () => Record<string, Tool>
      HIGH_RISK_TOOLS?: string[]
    }
    const tools = mod.createBrowserTools?.() ?? mod.browserTools?.() ?? {}
    return { tools, highRisk: mod.HIGH_RISK_TOOLS ?? [] }
  } catch {
    return { tools: {}, highRisk: [] }
  }
}

// 工具注册表(架构设计 §3.4):本地文件/终端/沙盒/屏幕/剪贴板/web + 远程知识库 + 浏览器桥
// workspace 非空(项目内会话)→ cwd 与 allowedDirs 以会话 workspace 为基准;否则回退全局用户工作目录
async function buildToolsRegistry(db: ReturnType<typeof openDb>, workspace?: string): Promise<{ tools: Record<string, GatedTool>; highRiskTools: Set<string> }> {
  // 无项目会话 workspace 默认 ''(falsy)→ 回退全局工作目录,防止 cwd/allowedDirs 变成空
  const base = resolveWorkspace(workspace, workspaceDir())
  const allowedDirs = resolveAllowedDirs(base, getAllowedDirsFromSettings((k) => getSetting(db, k)))
  // 登记当前注册表的目录数组:addAllowedDir 就地 push 让工具闭包立即生效(单引擎单 run,无并发)
  activeAllowedDirs = allowedDirs
  const cwd = base
  const web = getBootstrapCache().web
  const commandTool: GatedTool = {
    ...tool({
      description: '在本地 shell 执行命令(默认超时 60s,输出截断 50KB);高危命令弹窗确认后执行,展示串=执行串',
      inputSchema: z.object({
        command: z.string(),
        timeoutSec: z.number().optional(),
      }),
      execute: async ({ command, timeoutSec }) => {
        logOperation('command_exec', `${command.slice(0, 200)} cwd=${cwd}`)
        const r = await commandExec(command, { cwd, allowedDirs, timeoutSec })
        logOperation('command_exec.done', `code=${r.code} stdout=${r.stdout.length}B stderr=${r.stderr.length}B`)
        return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut ?? false }
      },
    }),
    // 命令审批策略(架构设计 §3.4):白名单命令免审批,其余走引擎门控;
    // 相对路径判定以实际执行 cwd(会话 workspace)为基准,防止判定基准错位放行越界
    requiresApproval: (input: unknown) => {
      const command = (input as { command?: string } | null)?.command
      return typeof command === 'string' && needsApprovalFor(command, allowedDirs, cwd)
    },
  }
  const tools: Record<string, GatedTool> = {
    ...createFileTools({ allowedDirs, cwd }),
    command_exec: commandTool,
    sandbox_exec: createSandboxTool(await getSandbox()),
    screen_capture: screenCaptureTool,
    clipboard_read: clipboardReadTool,
    clipboard_write: clipboardWriteTool,
    ...createWebTools({ allowPrivate: web?.allow_private ?? false, searchEndpoint: web?.search_endpoint ?? '' }),
  }
  const highRiskTools = new Set<string>([
    ...FILES_HIGH_RISK,
    ...SCREEN_HIGH_RISK,
    ...CLIPBOARD_HIGH_RISK,
  ])
  const session = getCurrentSession()
  if (session) {
    const kb = createKbTools(session)
    Object.assign(tools, kb.tools)
    for (const n of kb.highRisk) highRiskTools.add(n)
  }
  const browser = await loadBrowserTools()
  Object.assign(tools, browser.tools)
  for (const n of browser.highRisk) highRiskTools.add(n)

  // 已装技能:指令注入 sysPrompt(3.11);已装 MCP 插件:工具注册 + 高危启发式(3.12)
  const mcp = await loadMcpTools(db)
  Object.assign(tools, mcp.tools)
  for (const n of mcp.highRisk) highRiskTools.add(n)
  return { tools, highRiskTools }
}

// loadInstalledSkillInstruction returns "## Skills" block from installed skills.
export async function loadInstalledSkillInstruction(): Promise<string> {
  try {
    const { listInstalledSkills } = await import('./skill/integration')
    const { loadSkillInstruction } = await import('./skill/integration')
    const installed = listInstalledSkills((k) => getSetting(appStore as any, k))
    const parts: string[] = []
    for (const name of Object.keys(installed)) {
      const instr = loadSkillInstruction(join(dataDir(), 'skills'), name)
      if (instr) parts.push(`## Skill: ${name}\n${instr}`)
    }
    return parts.length ? '\n\n## Skills\n' + parts.join('\n\n') : ''
  } catch {
    return ''
  }
}

async function loadMcpTools(db: ReturnType<typeof openDb>): Promise<{ tools: Record<string, GatedTool>; highRisk: Set<string> }> {
  try {
    const mod = await import('./mcp/integration')
    const { refreshPluginCredentials, getCredentials, installedMcpList } = await import('./mcp/installer')
    const { getMcpConfig } = await import('./gateway/marketplace')
    const session = getCurrentSession()
    if (!session) return { tools: {}, highRisk: new Set() }
    const deps = { getSetting: (k: string) => getSetting(db, k), setSetting: (k: string, v: string) => setSetting(db, k, v), getMcpConfig }
    await refreshPluginCredentials({ session, deps })
    const tools: Record<string, GatedTool> = {}
    const highRisk = new Set<string>()
    for (const rec of installedMcpList().filter((r) => r.enabled)) {
      const creds = getCredentials(rec.id)
      let handle: { tools: Record<string, import('ai').Tool>; close: () => Promise<void> } | null = null
      try {
        handle = await mod.createMcpToolsClient({
          transport: rec.transport === 'http' ? 'http' : 'stdio',
          command: rec.command,
          args: rec.args ?? [],
          url: rec.url ?? '',
          headers: creds?.headers ?? {},
          env: creds?.env ?? {},
          fetch: gatewayFetch,
        })
        for (const [tname, t] of Object.entries(handle.tools)) {
          const name = mod.pluginToolName(rec.name, tname)
          tools[name] = t as GatedTool
          const desc = typeof t.description === 'string' ? t.description : ''
          if (mod.isHighRiskTool(tname, desc)) highRisk.add(name)
        }
      } catch {
        handle?.close().catch(() => {})
      }
    }
    return { tools, highRisk }
  } catch {
    return { tools: {}, highRisk: new Set() }
  }
}

app.whenReady().then(async () => {
  const fs = await import('node:fs')
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.mkdirSync(join(dataDir(), 'workspaces'), { recursive: true })
  fs.mkdirSync(join(dataDir(), 'skills'), { recursive: true })
  fs.mkdirSync(join(dataDir(), 'mcp'), { recursive: true })
  initOperationLog()
  const db = openDb(dbPath())
  migrate(db)

  // 浏览器插件桥(3.15):固定监听 127.0.0.1:54321(可经 settings cdp.port 调整),退出时关闭
  let cdpServer: import('./cdp_server').CdpServer | null = null
  let cdpExtension = false
  const cdpPort = Number(getSetting(db, 'cdp.port') ?? '') || 54321
  import('./cdp_server').then((m) => m.startCdpServer({ port: cdpPort, onExtensionChange: (connected) => {
    cdpExtension = connected
    mainWindow?.webContents.send('cdp:extension', { connected })
  } })).then(
    (srv) => {
      cdpServer = srv
      console.log(`CDP bridge listening on 127.0.0.1:${srv.port}`)
    },
    (err: unknown) => {
      console.error('CDP bridge failed to start:', err instanceof Error ? err.message : err)
      mainWindow?.webContents.send('cdp:status', { running: false, port: cdpPort, error: err instanceof Error ? err.message : String(err) })
    },
  )
  app.on('will-quit', () => {
    void cdpServer?.close()
  })

  installCertificateVerification(join(dataDir(), 'fingerprints.json'), {
    onUnknownFingerprint: () => {
      // 首次连接自签证书:自动信任并记录(UI 提示由 renderer 呈现)
      if (mainWindow) {
        mainWindow.webContents.send('connection:status', 'trusting_cert')
      }
    },
  })

  const store: StoreLike = {
    createConversation: (input) => createConversation(db, input),
    listConversations: () => listConversations(db),
    getConversation: (id) => getConversation(db, id),
    updateConversationStatus: (id, status) => updateConversationStatus(db, id, status as any),
    deleteConversation: (id) => deleteConversation(db, id),
    setConversationTitle: (id, title) => setConversationTitle(db, id, title),
    setConversationStarred: (id, starred) => setConversationStarred(db, id, starred),
    setConversationArchived: (id, archived) => setConversationArchived(db, id, archived),
    setConversationWorkspace: (id, ws) => setConversationWorkspace(db, id, ws),
    touchConversation: (id) => touchConversation(db, id),
    listMessages: (cid) => listMessages(db, cid),
    updateMessageContent: (id, content) => updateMessageContent(db, id, content),
    deleteMessagesAfter: (cid, id) => deleteMessagesAfter(db, cid, id),
    deleteMessage: (id) => deleteMessage(db, id),
    appendMessage: (m) => appendMessage(db, m),
    addArtifact: (a) => addArtifact(db, a),
    listArtifacts: (cid) => listArtifacts(db, cid),
    getSetting: (k) => getSetting(db, k),
    setSetting: (k, v) => setSetting(db, k, v),
    getAllSettings: () => getAllSettings(db),
    createProject: (input) => createProject(db, input),
    listProjects: () => listProjects(db),
    getProject: (id) => getProject(db, id),
    deleteProject: (id) => deleteProject(db, id),
    setConversationProject: (cid, pid) => setConversationProject(db, cid, pid),
  }
  appStore = store

  const authDeps: AuthIpcDeps = {
    flow: { login, saveSession, loadSession, clearSession },
    getBootstrap,
    openExternal: (url) => shell.openExternal(url),
    onSessionEstablished: (session) => {
      // 任何登录/恢复路径都重建引擎:丢弃旧会话引擎(中止其运行,防止旧 token 继续跑)
      resetAgentEngine()
      startPoller(session)
      lastServerURL = session.serverURL
      setSetting(db, 'last_server_url', session.serverURL)
      mainWindow?.webContents.send('auth:logged-in', session)
    },
    onSessionCleared: () => {
      stopPoller()
      resetAgentEngine()
      // 登出必须清 MCP 凭证内存,否则下一个用户的会话沿用上一个用户的插件凭证
      clearMcpCredentials()
    },
  }

  lastServerURL = getSetting(db, 'last_server_url')

  registerIpcHandlers({
    ...buildHandlers(),
    'cdp:status': () => ({ running: cdpServer !== null, port: cdpPort, extension: cdpExtension, error: cdpServer === null ? 'CDP 桥启动失败(端口可能被占用)' : null }),
    ...buildAuthHandlers(authDeps),
    ...buildPluginHandlers({
      store: { getSetting: (k) => getSetting(db, k), setSetting: (k, v) => setSetting(db, k, v) },
      refreshBootstrap: async () => {
        const session = getCurrentSession()
        if (!session) throw new Error('未登录')
        const { config } = await getBootstrap(session)
        setBootstrapCache(config)
        return config
      },
    }),
    ...buildAgentHandlers({
      store,
      sysPrompt: async () => {
        const base =
          '你是 PicoAide,企业办公智能体助手。回答简洁准确;需要操作本机文件、终端、浏览器、屏幕时,使用可用工具。' +
          '浏览器操作(打开/导航/点击/输入)必须调用 browser_* 工具;若工具返回"浏览器插件未连接",必须明确告知用户浏览器插件未就绪(需在 Chrome/Edge 安装 PicoAide 扩展),不得虚构操作结果。' +
          '保持行动直到任务完成:工具或命令失败时先读错误信息、修正后重试,并尝试替代方案继续推进,不要因单次失败就停止或把任务推回给用户;' +
          '穷尽合理尝试之后仍受阻,才说明原因并给出可行建议。'
        try {
          const extra = await loadInstalledSkillInstruction()
          return extra ? base + extra : base
        } catch {
          return base
        }
      },
      createModel: () => {
        const session = getCurrentSession()
        if (!session) throw new Error('未登录')
        const bootstrap = getBootstrapCache()
        const model = bootstrap.models.find((m) => m.id === bootstrap.default_model) ?? bootstrap.models[0]
        if (!model) throw new Error('无可用模型')
        return makeGatewayModel(session.serverURL, session.token, model.id)
      },
      getTools: (workspace?: string) => buildToolsRegistry(db, workspace),
      getWindow: () => mainWindow,
      listAllowedDirs: () => resolveAllowedDirs(workspaceDir(), getAllowedDirsFromSettings((k) => getSetting(db, k))),
      listProjectPaths: () => listProjects(db).map((p) => p.path),
      autoTitle: async ({ conversationId }) => {
        const conv = store.getConversation(conversationId)
        if (!conv || conv.title !== '') return
        // 并发去重:ask + editAndRerun 双触发时只跑一次(同会话 in-flight 锁)
        if (titleInflight.has(conversationId)) return
        titleInflight.add(conversationId)
        try {
          const msgs = store.listMessages(conversationId)
          const firstUser = msgs.find((m) => m.role === 'user')
          if (!firstUser || !firstUser.content) return
          const session = getCurrentSession()
          if (!session) return
          const bootstrap = getBootstrapCache()
          const model = bootstrap.models.find((m) => m.id === bootstrap.default_model) ?? bootstrap.models[0]
          if (!model) return
          let title = ''
          try {
            title = await generateTitle(
              makeGatewayModel(session.serverURL, session.token, model.id),
              firstUser.content,
              { fetch: gatewayFetch },
            )
          } catch {
            // 网关失败兜底:截取首条用户消息
            title = fallbackTitle(firstUser.content)
          }
          // 生成期间用户可能已手动重命名:仅在仍为空时写入
          if (title && store.getConversation(conversationId)?.title === '') {
            store.setConversationTitle(conversationId, title)
            // 实时通知 renderer 刷新侧边栏标题(不等下次 loadConversations)
            mainWindow?.webContents.send('chat:title', { conversationId, title })
          }
        } finally {
          titleInflight.delete(conversationId)
        }
      },
      registerEngineReset: (reset) => {
        resetAgentEngine = reset
      },
      fetch: gatewayFetch,
      addAllowedDir: (dir) => {
        // 关键:必须同步更新当前活跃工具注册表持有的 allowedDirs 数组(工具 execute 闭包引用它),
        // 否则越界授权后的"自动重试"仍走旧目录清单再次越界失败(要等下次 getTools 重建才生效)。
        if (activeAllowedDirs && !activeAllowedDirs.includes(dir)) activeAllowedDirs.push(dir)
        const current = getAllowedDirsFromSettings((k) => getSetting(db, k))
        if (!current.includes(dir)) {
          current.push(dir)
          setSetting(db, 'allowed_dirs', JSON.stringify(current))
        }
      },
    }),
  })

  handleAuthDeepLink = (url: string) => handleAuthDeepLinkImpl(url, authDeps)
  for (const arg of process.argv) {
    if (arg.startsWith('picoaide://')) handleAuthDeepLinkImpl(arg, authDeps)
  }

  buildMenu()
  createWindow()

  // 窗口状态记忆(chatbox window_state):重启恢复位置/尺寸
  const savedBounds = getSetting(db, 'window_bounds')
  if (savedBounds) {
    try {
      const b = JSON.parse(savedBounds) as { x?: number; y?: number; width?: number; height?: number }
      if (typeof b.width === 'number' && typeof b.height === 'number') {
        mainWindow?.setBounds({ x: b.x ?? 0, y: b.y ?? 0, width: b.width, height: b.height })
      }
    } catch {
      // 损坏的状态忽略
    }
  }
  mainWindow?.on('close', () => {
    const b = mainWindow?.getBounds()
    if (b) setSetting(db, 'window_bounds', JSON.stringify(b))
  })

  // 深色模式跟随系统(HIG):nativeTheme 变化时广播给所有窗口
  nativeTheme.on('updated', () => {
    const theme: 'dark' | 'light' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:changed', theme)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// OIDC 深链:picoaide://auth?token=...  →  token 即正式 api_token,直接建会话
function handleAuthDeepLinkImpl(url: string, deps: AuthIpcDeps): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return
  }
  if (u.protocol !== 'picoaide:' || u.hostname !== 'auth') return
  const token = u.searchParams.get('token')
  if (!token) return
  const serverURL = getCurrentSession()?.serverURL ?? lastServerURL ?? null
  if (!serverURL) return
  void establishSession({ serverURL, username: 'oidc', token }, deps).then(() => {
    mainWindow?.webContents.send('auth:logged-in', { serverURL, username: 'oidc', token })
  })
}

let handleAuthDeepLink: ((url: string) => void) | null = null

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleAuthDeepLink?.(url)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', (_event, argv) => {
  for (const arg of argv) {
    if (arg.startsWith('picoaide://')) handleAuthDeepLink?.(arg)
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

export { getBootstrapCache, getCurrentSession } from './session_cache'
