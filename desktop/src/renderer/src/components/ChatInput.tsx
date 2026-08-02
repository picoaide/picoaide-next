import { useState } from 'react'
import { Square, Send } from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { cn } from '../lib/utils'
import { useChatStore, type Mode } from '../stores/chat'

const MODES: { id: Mode; label: string; available: boolean }[] = [
  { id: 'ask', label: 'Ask', available: true },
  { id: 'plan', label: 'Plan', available: false },
  { id: 'craft', label: 'Craft', available: false },
]

export default function ChatInput() {
  const [value, setValue] = useState('')
  const streaming = useChatStore((s) => s.streaming)
  const mode = useChatStore((s) => s.mode)
  const setMode = useChatStore((s) => s.setMode)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const cancel = useChatStore((s) => s.cancel)

  const send = () => {
    const text = value.trim()
    if (!text) return
    setValue('')
    void sendMessage(text)
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
      </div>
    </div>
  )
}
