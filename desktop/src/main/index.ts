import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers, buildHandlers, buildAgentHandlers, buildAuthHandlers } from './ipc'
import type { AuthIpcDeps, StoreLike } from './ipc'
import { openDb } from './store/db'
import { migrate } from './store/migrations'
import {
  createConversation, listConversations, getConversation,
  updateConversationStatus, deleteConversation, setConversationTitle, touchConversation,
} from './store/conversations'
import { listMessages, appendMessage } from './store/messages'
import { addArtifact, listArtifacts } from './store/artifacts'
import { getSetting, setSetting, getAllSettings } from './store/settings'
import { dataDir, dbPath } from './paths'
import { installCertificateVerification } from './gateway/tls'
import { createGatewayModel as makeGatewayModel } from './agent/provider'
import { login, saveSession, loadSession, clearSession } from './gateway/auth'
import { getBootstrap } from './gateway/bootstrap'
import { createHealthPoller } from './gateway/health'
import type { Session } from './gateway/config'
import { establishSession, clearCaches, getBootstrapCache, getCurrentSession } from './session_cache'

let mainWindow: BrowserWindow | null = null
let poller: ReturnType<typeof createHealthPoller> | null = null
// 最近一次成功登录的服务器地址(设置表持久化),OIDC 深链回跳时用
let lastServerURL: string | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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

app.whenReady().then(async () => {
  const db = openDb(dbPath())
  migrate(db)

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
    touchConversation: (id) => touchConversation(db, id),
    listMessages: (cid) => listMessages(db, cid),
    appendMessage: (m) => appendMessage(db, m),
    addArtifact: (a) => addArtifact(db, a),
    listArtifacts: (cid) => listArtifacts(db, cid),
    getSetting: (k) => getSetting(db, k),
    setSetting: (k, v) => setSetting(db, k, v),
    getAllSettings: () => getAllSettings(db),
  }

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
    onSessionCleared: () => stopPoller(),
  }

  lastServerURL = getSetting(db, 'last_server_url')

  registerIpcHandlers({
    ...buildHandlers(),
    ...buildAuthHandlers(authDeps),
    ...buildAgentHandlers({
      store,
      sysPrompt:
        '你是 PicoAide,企业办公智能体助手。回答简洁准确;需要操作本机文件、终端、浏览器、屏幕时,使用可用工具。',
      createModel: () => {
        const session = getCurrentSession()
        if (!session) throw new Error('未登录')
        const bootstrap = getBootstrapCache()
        const model = bootstrap.models.find((m) => m.id === bootstrap.default_model) ?? bootstrap.models[0]
        if (!model) throw new Error('无可用模型')
        return makeGatewayModel(session.serverURL, session.token, model.id)
      },
      getWindow: () => mainWindow,
    }),
  })

  handleAuthDeepLink = (url: string) => handleAuthDeepLinkImpl(url, authDeps)
  for (const arg of process.argv) {
    if (arg.startsWith('picoaide://')) handleAuthDeepLinkImpl(arg, authDeps)
  }

  createWindow()

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
