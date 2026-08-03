import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Session, BootstrapConfig } from '../main/gateway/config'
import type { AgentEvent } from '../main/agent/events'
import type { ArtifactRow, ConversationRow, MessageRow, ProjectRow } from '../main/ipc'

type Unsub = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export interface LoginResult {
  session: Session & { persisted: boolean }
  bootstrap: BootstrapConfig
}

const api = {
  version: () => ipcRenderer.invoke('picoaide:version'),
  login: (serverURL: string, username: string, password: string): Promise<LoginResult> =>
    ipcRenderer.invoke('auth:login', { serverURL, username, password }),
  loadSession: (): Promise<Session | null> => ipcRenderer.invoke('auth:loadSession'),
  logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  refreshBootstrap: (): Promise<BootstrapConfig> => ipcRenderer.invoke('auth:refreshBootstrap'),
  oidcLogin: (serverURL: string): Promise<void> => ipcRenderer.invoke('auth:oidcLogin', { serverURL }),
  chatNew: (input?: { title?: string; mode?: string; projectId?: number | null }): Promise<number> =>
    ipcRenderer.invoke('chat:new', input),
  projectList: (): Promise<ProjectRow[]> => ipcRenderer.invoke('project:list'),
  projectCreate: (input: { name: string; path: string }): Promise<number> =>
    ipcRenderer.invoke('project:create', input),
  projectDelete: (id: number): Promise<void> => ipcRenderer.invoke('project:delete', { id }),
  moveConversation: (conversationId: number, projectId: number | null): Promise<void> =>
    ipcRenderer.invoke('conversation:moveProject', { conversationId, projectId }),
  workspaceListFiles: (): Promise<string[]> => ipcRenderer.invoke('workspace:listFiles'),
  pickDirectory: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickDirectory'),
  chatAsk: (conversationId: number, content: string): Promise<void> =>
    ipcRenderer.invoke('chat:ask', { conversationId, content }),
  chatContinue: (conversationId: number): Promise<void> =>
    ipcRenderer.invoke('chat:continue', { conversationId }),
  approvePlan: (conversationId: number, ok: boolean): Promise<void> =>
    ipcRenderer.invoke('chat:approvePlan', { conversationId, ok }),
  chatCancel: (): Promise<void> => ipcRenderer.invoke('chat:cancel'),
  chatList: (): Promise<ConversationRow[]> => ipcRenderer.invoke('chat:list'),
  listRunningConversations: (): Promise<ConversationRow[]> => ipcRenderer.invoke('chat:listRunning'),
  chatMessages: (conversationId: number): Promise<MessageRow[]> =>
    ipcRenderer.invoke('chat:messages', { conversationId }),
  chatMessagesPaged: (input: { conversationId: number; offset: number; limit: number }): Promise<MessageRow[]> =>
    ipcRenderer.invoke('chat:messagesPaged', input),
  chatArtifacts: (conversationId: number): Promise<ArtifactRow[]> =>
    ipcRenderer.invoke('chat:artifacts', { conversationId }),
  chatDelete: (conversationId: number): Promise<void> => ipcRenderer.invoke('chat:delete', { conversationId }),
  confirm: (requestId: string, ok: boolean): Promise<void> =>
    ipcRenderer.invoke('agent:confirm', { requestId, ok }),
  artifactShowInFolder: (path: string): Promise<void> => ipcRenderer.invoke('artifact:showInFolder', { path }),
  ready: (): Promise<void> => ipcRenderer.invoke('picoaide:rendererReady'),
  getTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb: (t: 'dark' | 'light') => void): Unsub => subscribe('theme:changed', cb),
  onMenuCommand: (cb: (cmd: 'settings' | 'new-chat' | 'new-project') => void): Unsub =>
    subscribe('menu:command', cb),
  onAgentEvent: (cb: (ev: AgentEvent) => void): Unsub => subscribe('agent:event', cb),
  onInterrupted: (cb: (list: ConversationRow[]) => void): Unsub => subscribe('chat:interrupted', cb),
  onConnectionStatus: (cb: (status: 'online' | 'offline' | 'auth_expired' | 'trusting_cert') => void): Unsub =>
    subscribe('connection:status', cb),
  onLoggedIn: (cb: (session: Session) => void): Unsub => subscribe('auth:logged-in', cb),
}

contextBridge.exposeInMainWorld('picoaide', api)

export type PicoaideAPI = typeof api
