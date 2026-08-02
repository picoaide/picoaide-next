import { useState } from 'react'
import { Square, Send } from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { cn } from '../lib/utils'
import { useChatStore, type Mode } from '../stores/chat'

const MODES: { id: Mode; label: string; available: boolean }[] = [
  { id: 'ask', label: 'Ask', available: true },
  { id: 'plan', label: 'Plan', available: true },
  { id: 'craft', label: 'Craft', available: true },
]

export default function ChatInput() {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const streaming = useChatStore((s) => s.streaming)
  const mode = useChatStore((s) => s.mode)
  const setMode = useChatStore((s) => s.setMode)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const cancel = useChatStore((s) => s.cancel)
  const approvePlan = useChatStore((s) => s.approvePlan)
  const loadConversations = useChatStore((s) => s.loadConversations)
  const activeId = useChatStore((s) => s.activeId)
  const conversations = useChatStore((s) => s.conversations)
  // Plan 状态驱动 UI(架构设计 §3.3.4):status='planning' 时显示 执行计划/取消
  const activeStatus = activeId === null ? null : (conversations.find((c) => c.id === activeId)?.status ?? null)
  const planning = activeStatus === 'planning' && !streaming

  const send = () => {
    const text = value.trim()
    if (!text) return
    setValue('')
    void sendMessage(text)
  }

  const onApprove = async (ok: boolean) => {
    if (activeId === null || busy) return
    setBusy(true)
    await approvePlan(activeId, ok)
    await loadConversations()
    setBusy(false)
  }

  return (
    <div className="border-t bg-background px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex items-center gap-1">
          {MODES.map((m) => (
            <Button
              key={m.id}
              type="button"
              size="sm"
              variant={mode === m.id ? 'default' : 'ghost'}
              disabled={!m.available}
              title={m.available ? undefined : '即将推出'}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </Button>
          ))}
        </div>
        {planning ? (
          <div className="flex items-center justify-center gap-3 rounded-md border bg-muted/30 px-3 py-3">
            <span className="text-sm text-muted-foreground">计划已生成,确认后开始执行</span>
            <Button size="sm" disabled={busy} onClick={() => void onApprove(true)}>
              执行计划
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void onApprove(false)}>
              取消
            </Button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <Textarea
              value={value}
              rows={2}
              placeholder="输入消息,Enter 发送,Shift+Enter 换行"
              className="resize-none"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            {streaming ? (
              <Button type="button" variant="outline" size="icon" title="停止" onClick={() => void cancel()}>
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="button" size="icon" disabled={!value.trim()} onClick={send} title="发送">
                <Send className={cn('h-4 w-4')} />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
