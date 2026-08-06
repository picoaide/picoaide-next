import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Session, BootstrapConfig } from '../main/gateway/config'
import type { AgentEvent } from '../main/agent/events'
import type { ArtifactReadResult, ArtifactRow, ConversationRow, MessageRow, ProjectRow } from '../main/ipc'
import type { McpInstalledRecord, McpListResult, McpRiskInfo, SettingsInfo, SkillRiskInfo, SkillsListResult, InstalledSkillRecord } from '../main/plugin_ipc'
import type { AttachmentInput, AttachResult } from '../shared/attachments'

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
  chatAsk: (conversationId: number, content: string, mode?: string): Promise<void> =>
    ipcRenderer.invoke('chat:ask', { conversationId, content, mode }),
  chatAttach: (conversationId: number, files: AttachmentInput[]): Promise<AttachResult[]> =>
    ipcRenderer.invoke('chat:attach', { conversationId, files }),
  chatQueue: (conversationId: number, content: string): Promise<boolean> =>
    ipcRenderer.invoke('chat:queue', { conversationId, content }),
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
  chatEditAndRerun: (input: { conversationId: number; messageId: number; content: string }): Promise<void> =>
    ipcRenderer.invoke('chat:editAndRerun', input),
  chatDeleteMessage: (messageId: number): Promise<void> => ipcRenderer.invoke('chat:deleteMessage', { messageId }),
  chatArtifacts: (conversationId: number): Promise<ArtifactRow[]> =>
    ipcRenderer.invoke('chat:artifacts', { conversationId }),
  chatDelete: (conversationId: number): Promise<void> => ipcRenderer.invoke('chat:delete', { conversationId }),
  chatRename: (conversationId: number, title: string): Promise<void> =>
    ipcRenderer.invoke('chat:rename', { conversationId, title }),
  chatSetStarred: (conversationId: number, starred: boolean): Promise<void> =>
    ipcRenderer.invoke('chat:setStarred', { conversationId, starred }),
  chatSetArchived: (conversationId: number, archived: boolean): Promise<void> =>
    ipcRenderer.invoke('chat:setArchived', { conversationId, archived }),
  chatExport: (conversationId: number): Promise<string> => ipcRenderer.invoke('chat:export', { conversationId }),
  chatSearch: (query: string): Promise<{ conversationId: number; title: string; snippet: string }[]> =>
    ipcRenderer.invoke('chat:search', { query }),
  confirm: (requestId: string, ok: boolean): Promise<void> =>
    ipcRenderer.invoke('agent:confirm', { requestId, ok }),
  artifactShowInFolder: (path: string): Promise<void> => ipcRenderer.invoke('artifact:showInFolder', { path }),
  artifactRead: (path: string): Promise<ArtifactReadResult> => ipcRenderer.invoke('artifact:read', { path }),
  ready: (): Promise<void> => ipcRenderer.invoke('picoaide:rendererReady'),
  getTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb: (t: 'dark' | 'light') => void): Unsub => subscribe('theme:changed', cb),
  onMenuCommand: (cb: (cmd: 'settings' | 'new-chat' | 'new-project') => void): Unsub =>
    subscribe('menu:command', cb),
  // 设置页(plugin 通道):技能/MCP 建议清单、安装、可访问目录、服务器信息
  settingsInfo: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings:info'),
  allowedDirs: (dirs?: string[]): Promise<string[]> => ipcRenderer.invoke('settings:allowedDirs', { dirs }),
  accent: (color?: string): Promise<string> => ipcRenderer.invoke('settings:accent', { color }),
  pluginSkillsList: (): Promise<SkillsListResult> => ipcRenderer.invoke('plugin:skills.list'),
  pluginSkillsInstall: (input: { name: string; confirmed?: boolean }): Promise<InstalledSkillRecord | { risk: SkillRiskInfo }> =>
    ipcRenderer.invoke('plugin:skills.install', input),
  pluginSkillsRemove: (input: { name: string }): Promise<void> => ipcRenderer.invoke('plugin:skills.remove', input),
  pluginMcpList: (): Promise<McpListResult> => ipcRenderer.invoke('plugin:mcp.list'),
  pluginMcpInstall: (input: { id: number; confirmed?: boolean }): Promise<McpInstalledRecord | { risk: McpRiskInfo }> =>
    ipcRenderer.invoke('plugin:mcp.install', input),
  pluginMcpRemove: (input: { id: number }): Promise<void> => ipcRenderer.invoke('plugin:mcp.remove', input),
  pluginMcpToggle: (input: { id: number; enabled: boolean }): Promise<McpInstalledRecord> =>
    ipcRenderer.invoke('plugin:mcp.toggle', input),
  cdpStatus: (): Promise<{ running: boolean; port: number; extension: boolean; error: string | null }> => ipcRenderer.invoke('cdp:status'),
  onCdpExtension: (cb: (payload: { connected: boolean }) => void): Unsub => subscribe('cdp:extension', cb),
  tlsResetFingerprints: (): Promise<void> => ipcRenderer.invoke('tls:resetFingerprints'),
  onAgentEvent: (cb: (ev: AgentEvent) => void): Unsub => subscribe('agent:event', cb),
  onInterrupted: (cb: (list: ConversationRow[]) => void): Unsub => subscribe('chat:interrupted', cb),
  onChatTitle: (cb: (payload: { conversationId: number; title: string }) => void): Unsub =>
    subscribe('chat:title', cb),
  onConnectionStatus: (cb: (status: 'online' | 'offline' | 'auth_expired' | 'trusting_cert' | 'cert_mismatch') => void): Unsub =>
    subscribe('connection:status', cb),
  onLoggedIn: (cb: (session: Session) => void): Unsub => subscribe('auth:logged-in', cb),
}

contextBridge.exposeInMainWorld('picoaide', api)

export type PicoaideAPI = typeof api
