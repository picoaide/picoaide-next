import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpcHandlers, buildHandlers, buildAgentHandlers } from './ipc'
import type { StoreLike } from './ipc'
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
import type { Session } from './gateway/config'

let mainWindow: BrowserWindow | null = null

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

  registerIpcHandlers({
    ...buildHandlers(),
    ...buildAgentHandlers({
      store,
      sysPrompt:
        '你是 PicoAide,企业办公智能体助手。回答简洁准确;需要操作本机文件、终端、浏览器、屏幕时,使用可用工具。',
      createModel: () => {
        const session = currentSession
        if (!session) throw new Error('未登录')
        const bootstrap = getBootstrapCache()
        const model = bootstrap.models.find((m) => m.id === bootstrap.default_model) ?? bootstrap.models[0]
        if (!model) throw new Error('无可用模型')
        return makeGatewayModel(session.serverURL, session.token, model.id)
      },
      getWindow: () => mainWindow,
    }),
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// getBootstrapCache returns the last fetched bootstrap (set by ipc login flow).
let bootstrapCache: import('./gateway/config').BootstrapConfig | null = null

export function setBootstrapCache(cfg: import('./gateway/config').BootstrapConfig | null) {
  bootstrapCache = cfg
}

export function getBootstrapCache() {
  return bootstrapCache ?? { default_model: '', models: [], skills: [], mcp: [], web: { allow_private: false, search_endpoint: '' } }
}

// currentSession is set by the login flow (ipc auth handlers in Task 2.7).
let currentSession: Session | null = null

export function setCurrentSession(s: Session | null) {
  currentSession = s
}

export function getCurrentSession(): Session | null {
  return currentSession
}

