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
} from './store/conversations'
import { createProject, listProjects, getProject, deleteProject, setConversationProject } from './store/projects'
import { listMessages, appendMessage } from './store/messages'
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
import { getAllowedDirsFromSettings, resolveAllowedDirs } from './tools/paths'
import { login, saveSession, loadSession, clearSession, gatewayFetch } from './gateway/auth'
import { generateTitle, fallbackTitle } from './agent/title'
import { getBootstrap } from './gateway/bootstrap'
import { createHealthPoller } from './gateway/health'
import type { Session } from './gateway/config'
import { establishSession, clearCaches, getBootstrapCache, getCurrentSession, setBootstrapCache } from './session_cache'
import { buildPluginHandlers } from './plugin_ipc'

let mainWindow: BrowserWindow | null = null
let poller: ReturnType<typeof createHealthPoller> | null = null

// macOS 原生应用菜单(HIG):Cmd+Q 退出、Cmd+, 设置、Cmd+N 新建会话;菜单命令经 menu:command 事件下发 renderer
function buildMenu(): void {
  if (process.platform !== 'darwin') return
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
      label: '文件',
      submenu: [
        { label: '新建会话', accelerator: 'Cmd+N', click: () => send('new-chat') },
        { label: '新建项目', accelerator: 'Cmd+Shift+N', click: () => send('new-project') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
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
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// 最近一次成功登录的服务器地址(设置表持久化),OIDC 深链回跳时用
let lastServerURL: string | null = null
// 启动扫描未完成任务用(架构设计 §3.3.1a):whenReady 内注入 store
let appStore: StoreLike | null = null
// 引擎重置钩子:登出/换账号时丢弃缓存的 AgentEngine(持有旧会话 model/token)
let resetAgentEngine: () => void = () => {}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
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
  const base = workspace ?? workspaceDir()
  const allowedDirs = resolveAllowedDirs(base, getAllowedDirsFromSettings((k) => getSetting(db, k)))
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
        const r = await commandExec(command, { cwd, allowedDirs, timeoutSec })
        return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut ?? false }
      },
    }),
    // 命令审批策略(架构设计 §3.4):白名单命令免审批,其余走引擎门控
    requiresApproval: (input: unknown) => {
      const command = (input as { command?: string } | null)?.command
      return typeof command === 'string' && needsApprovalFor(command, allowedDirs)
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
      const runner = mod.createMcpRunner({
        transport: (rec.transport === 'http' ? 'http' : 'stdio') as 'stdio' | 'http',
        command: rec.command,
        args: rec.args ?? [],
        url: rec.url ?? '',
        headers: creds?.headers ?? {},
        env: creds?.env ?? {},
        fetch: gatewayFetch,
      })
      try {
        const conn = await mod.connectRunner(runner)
        for (const t of conn.tools) {
          const name = mod.pluginToolName(rec.name, t.name)
          tools[name] = mod.toAiSdkTool(t, (args) => conn.callTool(t.name, args))
          if (mod.isHighRiskTool(t.name, t.description ?? '')) highRisk.add(name)
        }
      } catch {
        runner.close().catch(() => {})
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
  const db = openDb(dbPath())
  migrate(db)

  // 浏览器插件桥(3.15):固定监听 127.0.0.1:54321(可经 settings cdp.port 调整),退出时关闭
  let cdpServer: import('./cdp_server').CdpServer | null = null
  const cdpPort = Number(getSetting(db, 'cdp.port') ?? '') || 54321
  import('./cdp_server').then((m) => m.startCdpServer({ port: cdpPort })).then(
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
    setConversationWorkspace: (id, ws) => setConversationWorkspace(db, id, ws),
    touchConversation: (id) => touchConversation(db, id),
    listMessages: (cid) => listMessages(db, cid),
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
      startPoller(session)
      lastServerURL = session.serverURL
      setSetting(db, 'last_server_url', session.serverURL)
      mainWindow?.webContents.send('auth:logged-in', session)
    },
    onSessionCleared: () => {
      stopPoller()
      resetAgentEngine()
    },
  }

  lastServerURL = getSetting(db, 'last_server_url')

  registerIpcHandlers({
    ...buildHandlers(),
    'cdp:status': () => ({ running: cdpServer !== null, port: cdpPort }),
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
        const base = '你是 PicoAide,企业办公智能体助手。回答简洁准确;需要操作本机文件、终端、浏览器、屏幕时,使用可用工具。'
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
        const msgs = store.listMessages(conversationId)
        const firstUser = msgs.find((m) => m.role === 'user')
        if (!firstUser || !firstUser.content) return
        const session = getCurrentSession()
        if (!session) return
        const bootstrap = getBootstrapCache()
        const model = bootstrap.models.find((m) => m.id === bootstrap.default_model) ?? bootstrap.models[0]
        if (!model) return
        try {
          const title = await generateTitle(
            { serverURL: session.serverURL, token: session.token },
            model.id,
            firstUser.content,
            gatewayFetch,
          )
          if (title) store.setConversationTitle(conversationId, title)
        } catch {
          // 网关失败兜底:截取首条用户消息
          store.setConversationTitle(conversationId, fallbackTitle(firstUser.content))
        }
      },
      registerEngineReset: (reset) => {
        resetAgentEngine = reset
      },
      fetch: gatewayFetch,
      addAllowedDir: (dir) => {
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
