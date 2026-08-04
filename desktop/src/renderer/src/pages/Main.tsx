import { useEffect, useState } from 'react'
import {
  Archive, Check, ChevronDown, ChevronRight, Copy, Download, FolderPlus, Globe, LogOut, MoreHorizontal, Pencil, Pin,
  Plus, Search, Settings as SettingsIcon, Sparkles, Store, Trash2, Trash, Zap,
} from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import ArtifactsPanel from '../components/ArtifactsPanel'
import ChatInput from '../components/ChatInput'
import ConfirmDialog from '../components/ConfirmDialog'
import ConfirmModal from '../components/ConfirmModal'
import Messages from '../components/Messages'
import SearchDialog from '../components/SearchDialog'
import { useAuthStore } from '../stores/auth'
import { useChatStore, type ProjectView } from '../stores/chat'
import type { ConversationRow } from '../../../main/ipc'
import { useConnectionStore } from '../stores/connection'
import { toast } from 'sonner'
import { formatRelativeTime } from '../lib/time'
import { cn } from '../lib/utils'

// 项目标识色板(按项目 id 循环取色,柔和系,深浅主题均可用)
const PROJECT_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b',
  '#10b981', '#14b8a6', '#0ea5e9', '#3b82f6', '#84cc16',
]
const projectColor = (id: number) => PROJECT_COLORS[id % PROJECT_COLORS.length]

export default function Main({ onOpenSettings }: { onOpenSettings: (section?: 'mcp' | 'skills') => void }) {
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const session = useAuthStore((s) => s.session)
  const logout = useAuthStore((s) => s.logout)
  const conversations = useChatStore((s) => s.conversations)
  const projects = useChatStore((s) => s.projects)
  const activeId = useChatStore((s) => s.activeId)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const collapsedProjects = useChatStore((s) => s.collapsedProjects)
  const messages = useChatStore((s) => s.messages)
  const artifacts = useChatStore((s) => s.artifacts)
  const interrupted = useChatStore((s) => s.interrupted)
  const streaming = useChatStore((s) => s.streaming)
  const streamingText = useChatStore((s) => s.streamingText)
  const streamingReasoning = useChatStore((s) => s.streamingReasoning)
  const toolCalls = useChatStore((s) => s.toolCalls)
  const localError = useChatStore((s) => s.localError)
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages)
  const loadEarlierMessages = useChatStore((s) => s.loadEarlierMessages)
  const connStatus = useConnectionStore((s) => s.status)
  const browserConnected = useConnectionStore((s) => s.browserConnected)
  const [showNewProject, setShowNewProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [showUncategorized, setShowUncategorized] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [showBrowserHelp, setShowBrowserHelp] = useState(false)
  const { newConversation, loadConversations, selectConversation, deleteConversation, loadProjects, createProject, deleteProject, moveConversation, setActiveProject, toggleProjectCollapsed } = useChatStore.getState()

  useEffect(() => {
    // Cmd/Ctrl+P 全局搜索(chatbox SearchDialog)
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setShowSearch(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    void loadConversations()
    void loadProjects()
    // 启动扫描中断会话(架构设计 §3.3.1a 重跑恢复):主进程推送 + 拉取兜底(去重由 store 保证)
    void useChatStore.getState().checkInterrupted()
    const off = window.picoaide.onInterrupted((list) => useChatStore.getState().onInterrupted(list))
    // 浏览器插件桥状态:启动拉取一次 + 订阅实时变化
    void window.picoaide.cdpStatus().then((s) => useConnectionStore.getState().setBrowserConnected(s.extension))
    const offExt = window.picoaide.onCdpExtension(({ connected }) => useConnectionStore.getState().setBrowserConnected(connected))
    return () => {
      off()
      offExt()
    }
  }, [loadConversations, loadProjects])

  const activeProject = projects.find((p) => p.id === activeProjectId)

  const handleDelete = async (id: number) => {
    await deleteConversation(id)
    await loadConversations()
  }

  const handleContinue = async (id: number) => {
    await useChatStore.getState().continueConversation(id)
  }

  const pickProjectDir = async () => {
    const dirs = await window.picoaide.pickDirectory()
    if (dirs && dirs.length > 0) setProjectPath(dirs[0])
  }

  const handleCreateProject = async () => {
    if (!projectName.trim() || !projectPath.trim()) return
    const id = await createProject({ name: projectName.trim(), path: projectPath.trim() })
    setActiveProject(id)
    setShowNewProject(false)
    setProjectName('')
    setProjectPath('')
  }

  const handleDeleteProject = async (id: number) => {
    await deleteProject(id)
    await loadProjects()
  }

  const conversationsOf = (projectId: number | null) =>
    conversations.filter((c) => (projectId === null ? c.project_id == null : c.project_id === projectId) && c.archived === 0)

  const renderConversationRow = (c: ConversationRow) => {
    const startRename = () => {
      setRenamingId(c.id)
      setRenameValue(c.title)
    }
    const saveRename = async () => {
      await window.picoaide.chatRename(c.id, renameValue.trim())
      await loadConversations()
      setRenamingId(null)
    }
    const doExport = async () => {
      const md = await window.picoaide.chatExport(c.id)
      try {
        await navigator.clipboard.writeText(md)
        toast('已复制到剪贴板')
      } catch {
        toast('导出失败', { description: '请检查剪贴板权限' })
      }
    }
    if (renamingId === c.id) {
      return (
        <div key={c.id} className="ml-4 mb-1 flex items-center gap-1 px-3 py-1">
          <Input
            autoFocus
            value={renameValue}
            className="h-7 text-sm"
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveRename()
              if (e.key === 'Escape') setRenamingId(null)
            }}
          />
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void saveRename()}>
            <Check className="h-3.5 w-3.5" />
          </Button>
        </div>
      )
    }
    return (
      <div
        key={c.id}
        className={cn(
          'group relative mb-1 ml-2 mr-1 cursor-pointer rounded-lg px-3 py-2 transition-colors hover:bg-accent/60',
          c.id === activeId && 'bg-accent shadow-sm'
        )}
        onClick={() => void selectConversation(c.id)}
      >
        {c.id === activeId && <div className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-primary" />}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {c.starred === 1 && <Pin className="h-3 w-3 shrink-0 text-amber-500" />}
            <span className={cn('truncate', c.id === activeId && 'font-medium')}>{c.title || '未命名会话'}</span>
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatRelativeTime(c.updated_at)}</span>
        </div>
        {c.preview && <div className="mt-0.5 truncate text-xs text-muted-foreground">{c.preview}</div>}
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" title="更多操作">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void window.picoaide.chatSetStarred(c.id, c.starred !== 1)}>
                <Pin className="h-3.5 w-3.5" />
                {c.starred === 1 ? '取消置顶' : '置顶'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={startRename}>
                <Pencil className="h-3.5 w-3.5" /> 重命名
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void window.picoaide.chatSetArchived(c.id, true)}>
                <Archive className="h-3.5 w-3.5" /> 归档
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void doExport()}>
                <Download className="h-3.5 w-3.5" /> 导出
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void window.picoaide.chatSetArchived(c.id, false)} disabled={c.archived !== 1}>
                <Copy className="h-3.5 w-3.5" /> 取消归档
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setConfirmDeleteId(c.id)
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" title="移动到项目">
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void moveConversation(c.id, null)}>未分类</DropdownMenuItem>
              {projects.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => void moveConversation(c.id, p.id)}>
                  {p.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="删除会话"
            onClick={(e) => {
              e.stopPropagation()
              setConfirmDeleteId(c.id)
            }}
          >
            <Trash className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    )
  }

  const renderProjectGroup = (p: ProjectView) => {
    const collapsed = collapsedProjects.includes(p.id)
    const items = conversationsOf(p.id)
    const active = activeProjectId === p.id
    return (
      <div key={p.id} className="mb-1">
        <div
          className={cn(
            'group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/60',
            active && 'bg-accent/70'
          )}
          onClick={() => {
            setActiveProject(p.id)
            toggleProjectCollapsed(p.id)
          }}
        >
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
            style={{ backgroundColor: projectColor(p.id) }}
          >
            {(p.name.trim()[0] ?? '?').toUpperCase()}
          </div>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{items.length}</span>
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="删除项目(会话移入未分类,不删文件)"
              onClick={(e) => {
                e.stopPropagation()
                void handleDeleteProject(p.id)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {!collapsed && <div className="mt-0.5">{items.map(renderConversationRow)}</div>}
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      {connStatus === 'offline' && (
        <div className="bg-amber-500/15 px-4 py-1.5 text-center text-sm text-amber-700">
          已断开,将自动重连
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 flex-col border-r bg-muted/40 dark:bg-muted/60">
          {/* 品牌区 */}
          <div className="flex items-center gap-2 px-3 pb-1 pt-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
              P
            </div>
            <span className="text-sm font-semibold tracking-tight">PicoAide</span>
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto h-7 w-7 text-muted-foreground"
              title="搜索 (Cmd/Ctrl+P)"
              onClick={() => setShowSearch(true)}
            >
              <Search className="h-4 w-4" />
            </Button>
          </div>
          {/* 主操作:新建会话主按钮 + 更多(新建项目) */}
          <div className="flex gap-2 px-3 py-2">
            <Button className="h-8 flex-1" onClick={() => void newConversation()}>
              <Plus className="h-4 w-4" /> 新建会话
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8" title="更多创建选项">
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => void newConversation()}>
                  <Plus className="h-3.5 w-3.5" /> 新建会话
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowNewProject(true)}>
                  <FolderPlus className="h-3.5 w-3.5" /> 新建项目
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* 项目分组列表 */}
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {projects.map(renderProjectGroup)}
            {conversationsOf(null).length > 0 && (
              <>
                <div className="mb-1 mt-2 border-t pt-2" />
                {showUncategorized && <div className="mt-0.5">{conversationsOf(null).map(renderConversationRow)}</div>}
              </>
            )}
            {conversations.some((c) => c.archived === 1) && (
              <>
                <div
                  className="mb-1 mt-2 flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  onClick={() => setShowArchived((v) => !v)}
                >
                  {showArchived ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  已归档
                </div>
                {showArchived &&
                  conversations
                    .filter((c) => c.archived === 1)
                    .map((c) => renderConversationRow({ ...c, archived: 1 }))}
              </>
            )}
          </div>
          {/* 底部操作菜单区(Notion/Linear 式):头像行 + 垂直菜单 */}
          <div className="border-t p-2">
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {((session?.username ?? 'U')[0] ?? 'U').toUpperCase()}
              </div>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{session?.username ?? '用户'}</span>
              <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground" title={browserConnected ? '浏览器插件已连接(127.0.0.1:54321)' : '浏览器插件未连接'}>
                <span className={cn('h-1.5 w-1.5 rounded-full', connStatus === 'online' ? 'bg-green-500' : 'bg-red-500')} />
                {connStatus === 'online' ? '在线' : '离线'}
              </span>
            </div>
            <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
              {!browserConnected && (
                <Button
                  variant="ghost"
                  className="h-8 w-full justify-start gap-2 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setShowBrowserHelp(true)}
                >
                  <Globe className="h-4 w-4" /> 浏览器未连接
                </Button>
              )}
              <Button
                variant="ghost"
                className="h-8 w-full justify-start gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => onOpenSettings('mcp')}
              >
                <Store className="h-4 w-4" /> MCP 商店
              </Button>
              <Button
                variant="ghost"
                className="h-8 w-full justify-start gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => onOpenSettings('skills')}
              >
                <Zap className="h-4 w-4" /> 技能商店
              </Button>
              <Button
                variant="ghost"
                className="h-8 w-full justify-start gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => onOpenSettings()}
              >
                <SettingsIcon className="h-4 w-4" /> 设置
              </Button>
              <Button
                variant="ghost"
                className="h-8 w-full justify-start gap-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => void logout()}
              >
                <LogOut className="h-4 w-4" /> 登出
              </Button>
            </div>
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                <Messages
                  key={activeId ?? 'none'}
                  messages={messages}
                  streaming={streaming}
                  streamingText={streamingText}
                  streamingReasoning={streamingReasoning}
                  toolCalls={toolCalls}
                  error={localError}
                  hasMore={hasMoreMessages}
                  onLoadEarlier={() => void loadEarlierMessages()}
                />
              </div>
            <ChatInput />
          </div>
          {artifacts.length > 0 && <ArtifactsPanel artifacts={artifacts} />}
        </div>
        </main>
      </div>
      <ConfirmModal />
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="删除会话"
        description="会话及其消息将被永久删除,此操作不可恢复。"
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId !== null) void handleDelete(confirmDeleteId)
        }}
      />
      {interrupted.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-base">有未完成任务</CardTitle>
              <CardDescription>上次中断的会话将从最后一条消息继续执行(历史消息保留)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {interrupted.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="truncate">{c.title || '新会话'}</span>
                  <Button size="sm" onClick={() => void handleContinue(c.id)}>
                    继续
                  </Button>
                </div>
              ))}
            </CardContent>
            <CardFooter className="justify-end">
              <Button variant="outline" onClick={() => useChatStore.getState().clearInterrupted()}>
                暂不处理
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
      <Dialog open={showNewProject} onOpenChange={setShowNewProject}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>项目 = 命名的工作目录,其下会话的文件操作都发生在该目录中</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>项目名称</Label>
              <Input value={projectName} placeholder="如:月度报表" onChange={(e) => setProjectName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>工作目录</Label>
              <div className="flex gap-2">
                <Input value={projectPath} readOnly placeholder="请选择项目目录" />
                <Button variant="outline" onClick={() => void pickProjectDir()}>
                  浏览…
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewProject(false)}>
              取消
            </Button>
            <Button disabled={!projectName.trim() || !projectPath.trim()} onClick={() => void handleCreateProject()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SearchDialog open={showSearch} onClose={() => setShowSearch(false)} />
      <Dialog open={showBrowserHelp} onOpenChange={setShowBrowserHelp}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4" /> 连接浏览器插件
            </DialogTitle>
            <DialogDescription>让 Agent 操作你正在使用的 Chrome/Edge 浏览器</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs">1</span>
              <span>在 Chrome / Edge 扩展商店安装 <b>PicoAide Bridge</b> 扩展(扩展位于仓库 <code>browser-extension/</code> 目录,加载已解压的扩展程序)。</span>
            </div>
            <div className="flex gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs">2</span>
              <span>安装后无需任何配置,扩展默认直连本机 <code>127.0.0.1:54321</code>,即装即用。</span>
            </div>
            <div className="flex gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs">3</span>
              <span>连接成功后此处会变为 <b>“浏览器已连接”</b>,Agent 即可打开网页、搜索、点击与填写表单。</span>
            </div>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              浏览器工具完全走本机回环通道,不经服务端,离线可用;首次操作高风险动作(点击/输入)会弹出确认。
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowBrowserHelp(false)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
