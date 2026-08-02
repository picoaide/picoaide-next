import { useDeferredValue, useEffect, useRef } from 'react'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'
import ToolCalls from './ToolCalls'
import type { ChatMessage, ToolCallView } from '../stores/chat'

interface MessagesProps {
  messages: ChatMessage[]
  streaming: boolean
  streamingText: string
  toolCalls: ToolCallView[]
  hasMore: boolean
  onLoadEarlier: () => void
  error: string | null
}

export default function Messages({ messages, streaming, streamingText, toolCalls, error, hasMore, onLoadEarlier }: MessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  // 性能(4.4):流式文本经 useDeferredValue 降级渲染优先级,长回复不阻塞交互
  const deferredStreaming = useDeferredValue(streamingText)

  useEffect(() => {
    if (nearBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, streamingText, toolCalls])

  if (messages.length === 0 && !streaming && !error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        开始与 PicoAide 对话吧
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="mx-4 mt-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <ScrollArea className="flex-1" onViewportScroll={(e) => {
        const el = e.currentTarget
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}>
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} content={m.content} isError={m.is_error === 1} />
          ))}
          {streaming && (
            <div className="flex justify-start">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-lg border bg-card px-3 py-2 text-sm text-card-foreground">
                {deferredStreaming}
                <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-foreground" aria-hidden />
                <ToolCalls calls={toolCalls} />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  )
}

function Bubble({ role, content, isError, streaming }: { role: string; content: string; isError?: boolean; streaming?: boolean }) {
  const isUser = role === 'user'
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'border bg-card text-card-foreground',
          isError && 'border-destructive/50 text-destructive'
        )}
      >
        {content}
        {streaming && <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-foreground" aria-hidden />}
      </div>
    </div>
  )
}
