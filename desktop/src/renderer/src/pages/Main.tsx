import { useEffect } from 'react'
import { LogOut, Plus, Trash2 } from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import ChatInput from '../components/ChatInput'
import Messages from '../components/Messages'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'
import { useConnectionStore } from '../stores/connection'
import { cn } from '../lib/utils'

export default function Main() {
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const logout = useAuthStore((s) => s.logout)
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const streamingText = useChatStore((s) => s.streamingText)
  const localError = useChatStore((s) => s.localError)
  const connStatus = useConnectionStore((s) => s.status)
  const { newConversation, loadConversations, selectConversation, deleteConversation } = useChatStore.getState()

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  const model = bootstrap?.models.find((m) => m.id === bootstrap.default_model) ?? bootstrap?.models[0]
  const modelName = model?.display_name ?? bootstrap?.default_model ?? '—'

  const handleDelete = async (id: number) => {
    await deleteConversation(id)
    await loadConversations()
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
          <div className="p-3">
            <Button className="w-full" onClick={() => void newConversation()}>
              <Plus className="h-4 w-4" /> 新建会话
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {conversations.map((c) => (
              <div
                key={c.id}
                className={cn(
                  'group mb-1 flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent',
                  c.id === activeId && 'bg-accent'
                )}
                onClick={() => void selectConversation(c.id)}
              >
                <span className="truncate">{c.title || '新会话'}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleDelete(c.id)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <div className="border-t p-3">
            <Button variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" /> 退出登录
            </Button>
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-sm text-muted-foreground">{modelName}</span>
            <Badge variant={connStatus === 'online' ? 'success' : 'destructive'}>
              {connStatus === 'online' ? '在线' : connStatus === 'offline' ? '离线' : '已过期'}
            </Badge>
          </header>
          <div className="min-h-0 flex-1">
            <Messages
              messages={messages}
              streaming={streaming}
              streamingText={streamingText}
              error={localError}
            />
          </div>
          <ChatInput />
        </main>
      </div>
    </div>
  )
}
