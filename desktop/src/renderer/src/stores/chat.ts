import { create } from 'zustand'
import { toast } from 'sonner'
import { picoaide } from '../api/picoaide'
import type { AgentEvent } from '../../../main/agent/events'
import type { ArtifactRow, ConversationRow, MessageRow, ProjectRow } from '../../../main/ipc'
import { useApprovalsStore } from './approvals'
import { useConnectionStore } from './connection'

export type Mode = 'plan' | 'craft'

let pendingDelta = ''
let rafScheduled = false
const PAGE_SIZE = 100
// 取消后事件回执丢失时的强制复位窗口(canceled/done 事件正常到达时提前复位,此兜底不生效)
const CANCEL_FALLBACK_MS = 3000
// 运行代次:每次新任务递增;cancel 兜底定时器只复位"自己那代"的 streaming,
// 防止取消后 3s 内用户重发时误复位新运行的 streaming/审批队列
let runToken = 0
// 新建会话防重入(双击快速点击创建两个空会话)
let creatingConversation = false

// 工具卡片视图(流式期间由 tool_start/tool_end/tool_error 事件驱动)
export interface ToolCallView {
  id: string
  name: string
  input: unknown
  output?: unknown
  duration_ms?: number
  error?: string
  status: 'running' | 'done' | 'error' | 'pending'
  // 审批关联(chatbox paused 卡):confirm_required 后工具卡挂起,显示内嵌批准/拒绝
  requestId?: string
  target?: string
  reason?: string
}

interface ChatState {
  conversations: ConversationRow[]
  activeId: number | null
  messages: MessageRow[]
  artifacts: ArtifactRow[]
  // 项目(侧边栏分组;workspace 由主进程按项目路径/会话 id 落库)
  projects: ProjectRow[]
  activeProjectId: number | null
  collapsedProjects: number[]
  // 启动扫描/推送的中断会话(架构设计 §3.3.1a 重跑恢复),非空时 UI 提示"是否继续"
  interrupted: ConversationRow[]
  streaming: boolean
  streamingText: string
  streamingReasoning: string
  toolCalls: ToolCallView[]
  mode: Mode
  localError: string | null
  hasMoreMessages: boolean
  loadedTotal: number
  loadingEarlier: boolean
  loadEarlierMessages: () => Promise<void>
  newConversation: () => Promise<number | null>
  loadConversations: () => Promise<void>
  selectConversation: (id: number) => Promise<void>
  deleteConversation: (id: number) => Promise<void>
  sendMessage: (content: string) => Promise<boolean>
  continueConversation: (id: number) => Promise<void>
  approvePlan: (id: number, ok: boolean) => Promise<void>
  cancel: () => Promise<void>
  setMode: (m: Mode) => void
  // 消息操作(chatbox 语义):重新生成 = 截断重跑;编辑 = 改内容+截断重跑;引用 = 插入输入框
  editMessage: (messageId: number, content: string) => Promise<void>
  deleteMessage: (messageId: number) => Promise<void>
  quoteMessage: (content: string) => void
  pendingQuote: string | null
  consumeQuote: () => string | null
  pendingPrompt: string | null
  applyPrompt: (text: string) => void
  consumePrompt: () => string | null
  checkInterrupted: () => Promise<void>
  onInterrupted: (list: ConversationRow[]) => void
  clearInterrupted: () => void
  onAgentEvent: (ev: AgentEvent) => void
  clearLocalError: () => void
  loadProjects: () => Promise<void>
  createProject: (input: { name: string; path: string }) => Promise<number>
  deleteProject: (id: number) => Promise<void>
  moveConversation: (conversationId: number, projectId: number | null) => Promise<void>
  setActiveProject: (id: number | null) => void
  toggleProjectCollapsed: (id: number) => void
  onChatTitle: (conversationId: number, title: string) => void
}

export const useChatStore = create<ChatState>((set, get) => {
  // 任务运行统一骨架(sendMessage/continueConversation/approvePlan/editMessage 共用):
  // 递增代次防 cancel 兜底误伤、置 streaming、成功后刷会话列表、失败兜底复位。
  // 各任务在 fn 内自行守卫(切走/新建会话时返回 false 丢弃结果,不覆盖新会话视图)
  async function runTask(label: string, fn: () => Promise<boolean>): Promise<boolean> {
    pendingDelta = ''
    runToken++
    set({ streaming: true, streamingText: '', streamingReasoning: '', localError: null })
    try {
      const ok = await fn()
      if (!ok) return false
      await get().loadConversations()
      return true
    } catch (e) {
      set((s) => ({
        streaming: false,
        streamingText: '',
        streamingReasoning: '',
        localError: s.localError ?? (e instanceof Error && e.message ? e.message : `${label}失败,请重试`),
      }))
      return false
    }
  }

  // 中断会话合并守卫(去重:已有提示则不覆盖;启动拉取与主进程推送可能重复触发)
  function mergeInterrupted(list: ConversationRow[]): void {
    set((s) => ({ interrupted: s.interrupted.length > 0 ? s.interrupted : list }))
  }

  return {
  conversations: [],
  activeId: null,
  messages: [],
  artifacts: [],
  projects: [],
  activeProjectId: null,
  collapsedProjects: [],
  interrupted: [],
  streaming: false,
  streamingText: '',
  streamingReasoning: '',
  toolCalls: [],
  mode: 'craft',
  localError: null,
  hasMoreMessages: false,
  loadedTotal: 0,
  loadingEarlier: false,
  pendingQuote: null,
  pendingPrompt: null,

  newConversation: async () => {
    if (creatingConversation) return null
    creatingConversation = true
    try {
      // 流式运行中新建:先停当前任务,否则旧 run 事件串到新会话且引擎单槽被占
      if (get().streaming) await get().cancel()
      const id = await picoaide().chatNew({ mode: get().mode, projectId: get().activeProjectId })
      const [conversations, projects] = await Promise.all([picoaide().chatList(), picoaide().projectList()])
      pendingDelta = ''
      set({ conversations, projects, activeId: id, messages: [], artifacts: [], streaming: false, streamingText: '', streamingReasoning: '', toolCalls: [], localError: null, hasMoreMessages: false, loadedTotal: 0 })
      return id
    } finally {
      creatingConversation = false
    }
  },

  loadProjects: async () => {
    set({ projects: await picoaide().projectList() })
  },

  createProject: async (input) => {
    const id = await picoaide().projectCreate(input)
    await get().loadProjects()
    return id
  },

  deleteProject: async (id) => {
    await picoaide().projectDelete(id)
    set((s) => ({ activeProjectId: s.activeProjectId === id ? null : s.activeProjectId }))
    await get().loadProjects()
  },

  moveConversation: async (conversationId, projectId) => {
    await picoaide().moveConversation(conversationId, projectId)
    await Promise.all([get().loadConversations(), get().loadProjects()])
  },

  setActiveProject: (id) => set({ activeProjectId: id }),

  toggleProjectCollapsed: (id) =>
    set((s) => ({
      collapsedProjects: s.collapsedProjects.includes(id)
        ? s.collapsedProjects.filter((x) => x !== id)
        : [...s.collapsedProjects, id],
    })),

  onChatTitle: (conversationId, title) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, title } : c)),
    })),

  loadConversations: async () => {
    set({ conversations: await picoaide().chatList() })
  },

  // 分页(4.4):首次加载最近 PAGE_SIZE 条,向上滚动加载更早
  selectConversation: async (id) => {
    // 流中切换会话:先停掉当前运行,否则流式增量/toolCalls 会串台显示到新会话
    if (get().activeId !== id && get().streaming) {
      await get().cancel()
    }
    const [all, artifacts] = await Promise.all([picoaide().chatMessages(id), picoaide().chatArtifacts(id)])
    const page = all.slice(-PAGE_SIZE)
    pendingDelta = ''
    set({
      activeId: id,
      messages: page,
      artifacts,
      hasMoreMessages: all.length > PAGE_SIZE,
      loadedTotal: page.length,
      streaming: false,
      streamingText: '',
      streamingReasoning: '',
      toolCalls: [],
      localError: null,
    })
  },

  loadEarlierMessages: async () => {
    if (get().loadingEarlier) return
    const { activeId, loadedTotal } = get()
    if (activeId === null) return
    set({ loadingEarlier: true })
    try {
      const rows = await picoaide().chatMessagesPaged({ conversationId: activeId, offset: loadedTotal, limit: PAGE_SIZE })
      if (rows.length === 0) {
        set({ hasMoreMessages: false })
        return
      }
      set((s) => ({
        messages: [...rows, ...s.messages],
        loadedTotal: s.loadedTotal + rows.length,
        hasMoreMessages: rows.length === PAGE_SIZE,
      }))
    } finally {
      set({ loadingEarlier: false })
    }
  },

  deleteConversation: async (id) => {
    await picoaide().chatDelete(id)
    if (get().activeId === id) {
      set({ activeId: null, messages: [], artifacts: [], streaming: false, streamingText: '', toolCalls: [] })
    }
  },

  sendMessage: async (content): Promise<boolean> => {
    const text = content.trim()
    if (!text) return false
    if (get().streaming) {
      // 回复中发新消息 → 排队到当前步骤后(引擎多步队列,不打断);消息立即落库并刷新列表
      const id = get().activeId
      if (id === null) return false
      const ok = await picoaide().chatQueue(id, text)
      if (ok) {
        toast('已排队,当前步骤完成后自动处理')
        void reloadMessages()
        return true
      }
      set({ localError: '当前任务即将结束或会话已切换,请稍后再发' })
      return false
    }
    const conn = useConnectionStore.getState().status
    if (conn !== 'online') {
      set({ localError: '网络已断开,请恢复连接后再发送' })
      return false
    }
    // 同步置 streaming:关闭 chatNew await 期间双击/并发发送的竞态窗口(第二个发送直接返回)
    return runTask('发送', async () => {
      let activeId = get().activeId
      if (activeId === null) {
        activeId = await picoaide().chatNew({ mode: get().mode })
        // 首条消息创建会话后必须选中,否则后续消息每次都新建会话
        set({ activeId })
      }
      // 乐观追加用户消息;assistant 内容以流式增量呈现,结束后从 DB 重载
      set((s) => ({
        messages: [
          ...s.messages,
          { id: Date.now(), conversation_id: activeId, role: 'user', content: text, is_error: 0, tool_name: '', reasoning: '', tool_calls: '', tool_call_id: '', created_at: '' },
        ],
      }))
      await picoaide().chatAsk(activeId, text, get().mode)
      // 期间用户切走/新建会话:丢弃本次结果,不覆盖新会话视图
      if (useChatStore.getState().activeId !== activeId) return false
      const messages = await picoaide().chatMessages(activeId)
      set({ messages, streaming: false, streamingText: '', streamingReasoning: '' })
      return true
    })
  },

  // 重跑恢复(架构设计 §3.3.1a):选中会话 → 截断到最后一条 user 消息重跑;UI 保留历史显示
  continueConversation: async (id) => {
    if (get().streaming) await get().cancel()
    const messages = await picoaide().chatMessages(id)
    const artifacts = await picoaide().chatArtifacts(id)
    await runTask('继续', async () => {
      set({ activeId: id, messages, artifacts, toolCalls: [], interrupted: [] })
      await picoaide().chatContinue(id)
      if (useChatStore.getState().activeId !== id) return false
      return true
    })
  },

  // Plan 确认(架构设计 §3.3.4):ok → 第二轮带 tools 执行;!ok → rejected
  approvePlan: async (id, ok) => {
    if (get().streaming) await get().cancel()
    await runTask('操作', async () => {
      await picoaide().approvePlan(id, ok)
      if (useChatStore.getState().activeId !== id) return false
      set({ streaming: false })
      return true
    })
  },

  cancel: async () => {
    const token = runToken
    await picoaide().chatCancel()
    // 兜底:事件回执丢失(主进程异常/竞态)时强制复位,避免停止按钮永久卡死;
    // 正常路径 done/canceled/error 事件会提前复位,此定时器空转。
    // 只复位"自己那代"的运行:取消后 3s 内新任务已启动(runToken 递增)时不误伤。
    setTimeout(() => {
      const s = useChatStore.getState()
      if (runToken === token && s.streaming) {
        useChatStore.setState({ streaming: false, streamingText: '', streamingReasoning: '', toolCalls: [] })
        useApprovalsStore.getState().clear()
      }
    }, CANCEL_FALLBACK_MS)
  },

  setMode: (m) => set({ mode: m }),

  // 消息编辑:改内容 + 截断重跑;UI 先展示"正在重新生成"状态,完成后从 DB 重载
  editMessage: async (messageId, content) => {
    const { activeId } = get()
    if (activeId === null) return
    // 流式中编辑:先停当前任务,避免与引擎单运行守卫冲突(否则报"已有任务在运行"且旧 run 继续跑)
    if (get().streaming) await get().cancel()
    await runTask('编辑', async () => {
      await picoaide().chatEditAndRerun({ conversationId: activeId, messageId, content })
      // 期间切走:丢弃结果
      if (useChatStore.getState().activeId !== activeId) return false
      const messages = await picoaide().chatMessages(activeId)
      set({ messages, streaming: false, streamingText: '' })
      return true
    })
  },

  quoteMessage: (content) => set({ pendingQuote: content }),
  consumeQuote: () => {
    const q = get().pendingQuote
    set({ pendingQuote: null })
    return q
  },

  // 空状态示例提示词:点击填入输入框(与 quote 同机制,一次消费)
  applyPrompt: (text) => set({ pendingPrompt: text }),
  consumePrompt: () => {
    const p = get().pendingPrompt
    set({ pendingPrompt: null })
    return p
  },

  deleteMessage: async (messageId) => {
    const { activeId } = get()
    if (activeId === null) return
    await picoaide().chatDeleteMessage(messageId)
    const messages = await picoaide().chatMessages(activeId)
    set({ messages })
  },

  // 启动时拉取中断会话;与主进程推送合并(去重:已有提示则不覆盖)
  checkInterrupted: async () => {
    const list = await picoaide().listRunningConversations()
    if (list.length > 0) mergeInterrupted(list)
  },

  onInterrupted: (list) => mergeInterrupted(list),

  clearInterrupted: () => set({ interrupted: [] }),

  onAgentEvent: (ev) => {
    // 会话归属过滤:旧会话运行的迟到事件(切会话/新建/登出后引擎残留)不得污染当前视图
    if (ev.conversationId !== useChatStore.getState().activeId) return
    switch (ev.type) {
      case 'text_delta':
        // 性能(4.4):rAF 合帧渲染,>10 delta/s 的长回复不卡顿;渲染侧再叠 useDeferredValue
        pendingDelta += ev.data
        if (!rafScheduled && typeof requestAnimationFrame === 'function') {
          rafScheduled = true
          requestAnimationFrame(() => {
            rafScheduled = false
            const chunk = pendingDelta
            pendingDelta = ''
            if (chunk) set((s) => ({ streamingText: s.streamingText + chunk }))
          })
        } else if (typeof requestAnimationFrame !== 'function') {
          set((s) => ({ streamingText: s.streamingText + ev.data }))
        }
        break
      case 'tool_start':
        set((s) => ({
          toolCalls: [...s.toolCalls.filter((t) => t.id !== ev.data.id), { ...ev.data, status: 'running' }],
        }))
        break
      case 'reasoning_delta':
        set((s) => ({ streamingReasoning: s.streamingReasoning + ev.data }))
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
        // 内嵌审批卡(chatbox paused 卡):同 id 工具卡标记 pending + 关联回执
        set((s) => ({
          toolCalls: s.toolCalls.map((t) =>
            t.id === ev.data.tool_call_id
              ? {
                  ...t,
                  status: 'pending',
                  requestId: ev.data.request_id,
                  target: ev.data.target,
                  reason: ev.data.reason,
                }
              : t
          ),
        }))
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
        set({ streaming: false, streamingText: '', streamingReasoning: '', toolCalls: [] })
        useApprovalsStore.getState().clear()
        void reloadMessages()
        void reloadArtifacts()
        break
      case 'error':
        set({ streaming: false, streamingText: '', streamingReasoning: '', toolCalls: [], localError: ev.data })
        useApprovalsStore.getState().clear()
        void reloadMessages()
        void reloadArtifacts()
        break
    }
  },

  clearLocalError: () => set({ localError: null }),
}})

async function reloadMessages(): Promise<void> {
  const { activeId } = useChatStore.getState()
  if (activeId === null) return
  const messages = await picoaide().chatMessages(activeId)
  // 期间用户切走/新建会话:丢弃旧会话重载结果,不覆盖新会话视图
  if (useChatStore.getState().activeId !== activeId) return
  // 全量重载:同步分页账本,避免 loadedTotal 过期导致上滚重复加载
  useChatStore.setState({ messages, loadedTotal: messages.length, hasMoreMessages: false })
}

async function reloadArtifacts(): Promise<void> {
  const { activeId } = useChatStore.getState()
  if (activeId === null) return
  const artifacts = await picoaide().chatArtifacts(activeId)
  if (useChatStore.getState().activeId !== activeId) return
  useChatStore.setState({ artifacts })
}
