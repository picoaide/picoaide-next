import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Session, BootstrapConfig } from '../main/gateway/config'
import type { AgentEvent } from '../main/agent/events'
import type { ConversationRow, MessageRow } from '../main/ipc'

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
  chatNew: (input?: { title?: string; mode?: string }): Promise<number> => ipcRenderer.invoke('chat:new', input),
  chatAsk: (conversationId: number, content: string): Promise<void> =>
    ipcRenderer.invoke('chat:ask', { conversationId, content }),
  chatCancel: (): Promise<void> => ipcRenderer.invoke('chat:cancel'),
  chatList: (): Promise<ConversationRow[]> => ipcRenderer.invoke('chat:list'),
  chatMessages: (conversationId: number): Promise<MessageRow[]> =>
    ipcRenderer.invoke('chat:messages', { conversationId }),
  chatDelete: (conversationId: number): Promise<void> => ipcRenderer.invoke('chat:delete', { conversationId }),
  onAgentEvent: (cb: (ev: AgentEvent) => void): Unsub => subscribe('agent:event', cb),
  onConnectionStatus: (cb: (status: 'online' | 'offline' | 'auth_expired' | 'trusting_cert') => void): Unsub =>
    subscribe('connection:status', cb),
  onLoggedIn: (cb: (session: Session) => void): Unsub => subscribe('auth:logged-in', cb),
}

contextBridge.exposeInMainWorld('picoaide', api)

export type PicoaideAPI = typeof api
