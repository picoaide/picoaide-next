import { create } from 'zustand'
import { picoaide } from '../api/picoaide'
import type { AgentEvent } from '../../../main/agent/events'
import type { ArtifactRow, ConversationRow, MessageRow } from '../../../main/ipc'
import { useApprovalsStore } from './approvals'
import { useConnectionStore } from './connection'

export type Mode = 'ask' | 'plan' | 'craft'

export interface ChatMessage {
  id: number
  role: string
  content: string
  is_error: number
  tool_name: string
}

// 工具卡片视图(流式期间由 tool_start/tool_end/tool_error 事件驱动)
export interface ToolCallView {
  id: string
  name: string
  input: unknown
  output?: unknown
  duration_ms?: number
  error?: string
  status: 'running' | 'done' | 'error'
}

function mapMessages(rows: MessageRow[]): ChatMessage[] {
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    is_error: m.is_error,
    tool_name: m.tool_name ?? '',
  }))
}

interface ChatState {
  conversations: ConversationRow[]
  activeId: number | null
  messages: ChatMessage[]
  artifacts: ArtifactRow[]
  // 启动扫描/推送的中断会话(架构设计 §3.3.1a 重跑恢复),非空时 UI 提示"是否继续"
  interrupted: ConversationRow[]
  streaming: boolean
  streamingText: string
  toolCalls: ToolCallView[]
  mode: Mode
  localError: string | null
  newConversation: () => Promise<number | null>
  loadConversations: () => Promise<void>
  selectConversation: (id: number) => Promise<void>
  deleteConversation: (id: number) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  continueConversation: (id: number) => Promise<void>
  approvePlan: (id: number, ok: boolean) => Promise<void>
  cancel: () => Promise<void>
  setMode: (m: Mode) => void
  checkInterrupted: () => Promise<void>
  onInterrupted: (list: ConversationRow[]) => void
  clearInterrupted: () => void
  onAgentEvent: (ev: AgentEvent) => void
  clearLocalError: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  artifacts: [],
  interrupted: [],
  streaming: false,
  streamingText: '',
  toolCalls: [],
  mode: 'ask',
  localError: null,

  newConversation: async () => {
    const id = await picoaide().chatNew({ mode: get().mode })
    const conversations = await picoaide().chatList()
    set({ conversations, activeId: id, messages: [], artifacts: [], streaming: false, streamingText: '', toolCalls: [], localError: null })
    return id
  },

  loadConversations: async () => {
    set({ conversations: await picoaide().chatList() })
  },

  selectConversation: async (id) => {
    const messages = mapMessages(await picoaide().chatMessages(id))
    const artifacts = await picoaide().chatArtifacts(id)
    set({ activeId: id, messages, artifacts, streaming: false, streamingText: '', toolCalls: [], localError: null })
  },

  deleteConversation: async (id) => {
    await picoaide().chatDelete(id)
    if (get().activeId === id) {
      set({ activeId: null, messages: [], artifacts: [], streaming: false, streamingText: '', toolCalls: [] })
    }
  },

  sendMessage: async (content) => {
    const text = content.trim()
    if (!text || get().streaming) return
    const conn = useConnectionStore.getState().status
    if (conn !== 'online') {
      set({ localError: '网络已断开,请恢复连接后再发送' })
      return
    }
    let activeId = get().activeId
    if (activeId === null) {
      activeId = await picoaide().chatNew({ mode: get().mode })
    }
    const mode = get().mode
    const id = activeId
    // 乐观追加用户消息;assistant 内容以流式增量呈现,结束后从 DB 重载
    set((s) => ({
      messages: [...s.messages, { id: Date.now(), role: 'user', content: text, is_error: 0, tool_name: '' }],
      streaming: true,
      streamingText: '',
      localError: null,
    }))
    try {
      await picoaide().chatAsk(id, text)
      const messages = mapMessages(await picoaide().chatMessages(id))
      set({ messages, streaming: false, streamingText: '' })
      await get().loadConversations()
    } catch {
      set((s) => ({ streaming: false, streamingText: '', localError: s.localError ?? '发送失败,请重试' }))
    }
  },

  // 重跑恢复(架构设计 §3.3.1a):选中会话 → 截断到最后一条 user 消息重跑;UI 保留历史显示
  continueConversation: async (id) => {
    const messages = mapMessages(await picoaide().chatMessages(id))
    const artifacts = await picoaide().chatArtifacts(id)
    set({ activeId: id, messages, artifacts, streaming: true, streamingText: '', toolCalls: [], interrupted: [], localError: null })
    try {
      await picoaide().chatContinue(id)
      await get().loadConversations()
    } catch {
      set((s) => ({ streaming: false, localError: s.localError ?? '继续失败,请重试' }))
    }
  },

  // Plan 确认(架构设计 §3.3.4):ok → 第二轮带 tools 执行;!ok → rejected
  approvePlan: async (id, ok) => {
    set({ streaming: true, localError: null })
    try {
      await picoaide().approvePlan(id, ok)
      set({ streaming: false })
      await get().loadConversations()
    } catch {
      set((s) => ({ streaming: false, localError: s.localError ?? '操作失败,请重试' }))
    }
  },

  cancel: async () => {
    await picoaide().chatCancel()
  },

  setMode: (m) => set({ mode: m }),

  // 启动时拉取中断会话;与主进程推送合并(去重:已有提示则不覆盖)
  checkInterrupted: async () => {
    const list = await picoaide().listRunningConversations()
    if (list.length > 0) set((s) => ({ interrupted: s.interrupted.length > 0 ? s.interrupted : list }))
  },

  onInterrupted: (list) => set((s) => ({ interrupted: s.interrupted.length > 0 ? s.interrupted : list })),

  clearInterrupted: () => set({ interrupted: [] }),

  onAgentEvent: (ev) => {
    switch (ev.type) {
      case 'text_delta':
        set((s) => ({ streamingText: s.streamingText + ev.data }))
        break
      case 'tool_start':
        set((s) => ({
          toolCalls: [...s.toolCalls.filter((t) => t.id !== ev.data.id), { ...ev.data, status: 'running' }],
        }))
        break
      case 'tool_end':
        set((s) => ({
          toolCalls: [
            ...s.toolCalls.filter((t) => t.id !== ev.data.id),
            {
              id: ev.data.id,
              name: ev.data.name,
              input: s.toolCalls.find((t) => t.id === ev.data.id)?.input,
              output: ev.data.output,
              duration_ms: ev.data.duration_ms,
              status: 'done',
            },
          ],
        }))
        break
      case 'tool_error':
        set((s) => ({
          toolCalls: [
            ...s.toolCalls.filter((t) => t.id !== ev.data.id),
            {
              id: ev.data.id,
              name: ev.data.name,
              input: s.toolCalls.find((t) => t.id === ev.data.id)?.input,
              error: ev.data.error,
              status: 'error',
            },
          ],
        }))
        break
      case 'confirm_required':
        useApprovalsStore.getState().push(ev.data)
        break
      case 'artifact':
        // 流式期间实时追加;最终以 done 后的 DB 重载为准(事件不含 conversationId)
        set((s) => ({
          artifacts: s.artifacts.some((a) => a.path === ev.data.path)
            ? s.artifacts
            : [
                ...s.artifacts,
                {
                  id: Date.now(),
                  conversation_id: s.activeId ?? 0,
                  path: ev.data.path,
                  type: ev.data.type,
                  size: ev.data.size,
                  created_at: '',
                },
              ],
        }))
        break
      case 'done':
      case 'canceled':
        set({ streaming: false, streamingText: '', toolCalls: [] })
        useApprovalsStore.getState().clear()
        void reloadMessages()
        void reloadArtifacts()
        break
      case 'error':
        set({ streaming: false, streamingText: '', toolCalls: [], localError: ev.data })
        useApprovalsStore.getState().clear()
        void reloadMessages()
        void reloadArtifacts()
        break
    }
  },

  clearLocalError: () => set({ localError: null }),
}))

async function reloadMessages(): Promise<void> {
  const { activeId } = useChatStore.getState()
  if (activeId === null) return
  const messages = mapMessages(await picoaide().chatMessages(activeId))
  useChatStore.setState({ messages })
}

async function reloadArtifacts(): Promise<void> {
  const { activeId } = useChatStore.getState()
  if (activeId === null) return
  const artifacts = await picoaide().chatArtifacts(activeId)
  useChatStore.setState({ artifacts })
}
