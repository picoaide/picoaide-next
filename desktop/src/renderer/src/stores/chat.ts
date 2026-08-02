import { create } from 'zustand'
import { picoaide } from '../api/picoaide'
import type { AgentEvent } from '../../../main/agent/events'
import type { ConversationRow, MessageRow } from '../../../main/ipc'
import { useConnectionStore } from './connection'

export type Mode = 'ask' | 'plan' | 'craft'

export interface ChatMessage {
  id: number
  role: string
  content: string
  is_error: number
  tool_name: string
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
  streaming: boolean
  streamingText: string
  mode: Mode
  localError: string | null
  newConversation: () => Promise<number | null>
  loadConversations: () => Promise<void>
  selectConversation: (id: number) => Promise<void>
  deleteConversation: (id: number) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  cancel: () => Promise<void>
  setMode: (m: Mode) => void
  onAgentEvent: (ev: AgentEvent) => void
  clearLocalError: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  streaming: false,
  streamingText: '',
  mode: 'ask',
  localError: null,

  newConversation: async () => {
    const id = await picoaide().chatNew({ mode: get().mode })
    const conversations = await picoaide().chatList()
    set({ conversations, activeId: id, messages: [], streaming: false, streamingText: '', localError: null })
    return id
  },

  loadConversations: async () => {
    set({ conversations: await picoaide().chatList() })
  },

  selectConversation: async (id) => {
    const messages = mapMessages(await picoaide().chatMessages(id))
    set({ activeId: id, messages, streaming: false, streamingText: '', localError: null })
  },

  deleteConversation: async (id) => {
    await picoaide().chatDelete(id)
    if (get().activeId === id) {
      set({ activeId: null, messages: [], streaming: false, streamingText: '' })
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

  cancel: async () => {
    await picoaide().chatCancel()
  },

  setMode: (m) => set({ mode: m }),

  onAgentEvent: (ev) => {
    switch (ev.type) {
      case 'text_delta':
        set((s) => ({ streamingText: s.streamingText + ev.data }))
        break
      case 'done':
      case 'canceled':
        set({ streaming: false, streamingText: '' })
        void reloadMessages()
        break
      case 'error':
        set({ streaming: false, streamingText: '', localError: ev.data })
        void reloadMessages()
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
