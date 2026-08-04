import { useEffect, useState } from 'react'
import {
  Archive, Check, ChevronDown, ChevronRight, Copy, Download, FolderPlus, Globe, LogOut, MoreHorizontal, Pencil, Pin,
  Plus, Settings as SettingsIcon, Trash2, Trash,
} from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import ArtifactsPanel from '../components/ArtifactsPanel'
import ChatInput from '../components/ChatInput'
import ConfirmModal from '../components/ConfirmModal'
import Messages from '../components/Messages'
import SearchDialog from '../components/SearchDialog'
import { useAuthStore } from '../stores/auth'
import { useChatStore, type ProjectView } from '../stores/chat'
import { useConnectionStore } from '../stores/connection'
import { cn } from '../lib/utils'

export default function Main({ onOpenSettings }: { onOpenSettings: () => void }) {
  const bootstrap = useAuthStore((s) => s.bootstrap)
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
  const [showSearch, setShowSearch] = useState(false)
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

  const model = bootstrap?.models.find((m) => m.id === bootstrap.default_model) ?? bootstrap?.models[0]
  const modelName = model?.display_name ?? bootstrap?.default_model ?? '—'
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

  const renderConversationRow = (c: { id: number; title: string; starred?: number; archived?: number }) => {
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
        window.alert('已复制到剪贴板')
      } catch {
        window.alert('导出失败')
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
          'group ml-4 mb-1 flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent',
          c.id === activeId && 'bg-accent'
        )}
        onClick={() => void selectConversation(c.id)}
      >
        <span className="flex min-w-0 items-center gap-1">
          {c.starred === 1 && <Pin className="h-3 w-3 shrink-0 text-amber-500" />}
          <span className="truncate">{c.title || '新会话'}</span>
        </span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
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
                  if (window.confirm('删除会话?')) void handleDelete(c.id)
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
              if (window.confirm('删除会话?')) void handleDelete(c.id)
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
    return (
      <div key={p.id} className="mb-1">
        <div
          className={cn(
            'group flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm font-medium hover:bg-accent',
            activeProjectId === p.id && 'bg-accent'
          )}
          onClick={() => {
            setActiveProject(p.id)
            toggleProjectCollapsed(p.id)
          }}
        >
          <span className="flex min-w-0 items-center gap-1">
            {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{p.name}</span>
          </span>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
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
        {!collapsed && items.map(renderConversationRow)}
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
        <aside className="flex w-60 flex-col border-r bg-muted/20">
          <div className="flex gap-2 p-3">
            <Button className="flex-1" onClick={() => void newConversation()}>
              <Plus className="h-4 w-4" /> 新建会话
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => setShowNewProject(true)}>
              <FolderPlus className="h-4 w-4" /> 新建项目
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {projects.map(renderProjectGroup)}
            {conversationsOf(null).length > 0 && (
              <>
                <div className="mb-1 mt-2 px-3 py-1 text-xs text-muted-foreground">未分类</div>
                {conversationsOf(null).map(renderConversationRow)}
              </>
            )}
            {conversations.some((c) => c.archived === 1) && (
              <>
                <div
                  className="mb-1 mt-2 flex cursor-pointer items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
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
          <div className="border-t p-3">
            <Button variant="ghost" className="w-full justify-start text-muted-foreground" onClick={onOpenSettings}>
              <SettingsIcon className="h-4 w-4" /> 设置
            </Button>
            <Button variant="ghost" className="mt-1 w-full justify-start text-muted-foreground" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" /> 退出登录
            </Button>
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b px-4 py-2">
            <span className="truncate text-sm text-muted-foreground">
              {activeProject ? `${activeProject.name} · ` : ''}
              {modelName}
            </span>
            <div className="flex items-center gap-2">
              <Badge variant={browserConnected ? 'success' : 'outline'} title="浏览器插件桥(127.0.0.1:54321)">
                <Globe className="mr-1 h-3 w-3" />
                {browserConnected ? '浏览器已连接' : '浏览器未连接'}
              </Badge>
              <Badge variant={connStatus === 'online' ? 'success' : 'destructive'}>
                {connStatus === 'online' ? '在线' : connStatus === 'offline' ? '离线' : '已过期'}
              </Badge>
            </div>
          </header>
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                <Messages
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
            <ArtifactsPanel artifacts={artifacts} />
          </div>
        </main>
      </div>
      <ConfirmModal />
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
    </div>
  )
}
