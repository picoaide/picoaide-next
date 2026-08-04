import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { Check, Copy, MessageSquareQuote, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'
import ToolCalls from './ToolCalls'
import Markdown from './Markdown'
import { useChatStore, type ChatMessage, type ToolCallView } from '../stores/chat'

interface MessagesProps {
  messages: ChatMessage[]
  streaming: boolean
  streamingText: string
  streamingReasoning: string
  toolCalls: ToolCallView[]
  hasMore: boolean
  onLoadEarlier: () => void
  error: string | null
}

export default function Messages({ messages, streaming, streamingText, streamingReasoning, toolCalls, error, hasMore, onLoadEarlier }: MessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  // 性能(4.4):流式文本经 useDeferredValue 降级渲染优先级,长回复不阻塞交互
  const deferredStreaming = useDeferredValue(streamingText)
  const deferredReasoning = useDeferredValue(streamingReasoning)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')

  useEffect(() => {
    // 新消息/切会话后滚到底;rAF 延迟到 ScrollArea 布局完成,否则 scrollIntoView 会落到旧高度
    if (!nearBottom.current) return
    const raf = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
    return () => cancelAnimationFrame(raf)
  }, [messages, streamingText, streamingReasoning, toolCalls])

  if (messages.length === 0 && !streaming && !error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        开始与 PicoAide 对话吧
      </div>
    )
  }

  const startEdit = (m: ChatMessage) => {
    setEditingId(m.id)
    setEditValue(m.content)
  }


  const saveEdit = (m: ChatMessage) => {
    setEditingId(null)
    void useChatStore.getState().editMessage(m.id, editValue)
  }

  // chatbox 重新生成:重跑最后一条 user 消息(editMessage 语义 = 截断重跑)
  const regenerate = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser) void useChatStore.getState().editMessage(lastUser.id, lastUser.content)
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
          {messages.map((m) =>
            editingId === m.id ? (
              <div key={m.id} className="flex justify-end">
                <textarea
                  className="max-w-[80%] rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:border-ring"
                  value={editValue}
                  rows={Math.min(6, editValue.split('\n').length)}
                  autoFocus
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      saveEdit(m)
                    }
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              </div>
            ) : (
              <Bubble
                key={m.id}
                message={m}
                onEdit={() => startEdit(m)}
                onRegenerate={regenerate}
                onQuote={() => useChatStore.getState().quoteMessage(m.content)}
                onDelete={() => {
                  if (window.confirm('删除这条消息?')) void useChatStore.getState().deleteMessage(m.id)
                }}
              />
            )
          )}
          {streaming && (
            <div className="flex justify-start">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-lg border bg-card px-3 py-2 text-sm text-card-foreground">
                {/* 思考中:模型推理流(reasoning_delta);无任何输出时显示占位 */}
                {!deferredStreaming && !deferredReasoning && toolCalls.length === 0 && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-foreground" aria-hidden />
                    正在思考…
                  </div>
                )}
                {deferredStreaming ? (
                  <Markdown content={deferredStreaming} isAnimating />
                ) : (
                  deferredReasoning && (
                    <div className="mb-2 border-l-2 border-muted pl-2 text-xs italic text-muted-foreground whitespace-pre-wrap">
                      {deferredReasoning}
                    </div>
                  )
                )}
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

function Bubble({
  message,
  onEdit,
  onRegenerate,
  onQuote,
  onDelete,
}: {
  message: ChatMessage
  onEdit: () => void
  onRegenerate: () => void
  onQuote: () => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'
  const showActions = isUser || message.role === 'assistant'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时静默
    }
  }

  return (
    <div className={cn('group/message flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex max-w-[80%] flex-col', isUser ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
            isUser ? 'bg-primary text-primary-foreground' : 'border bg-card text-card-foreground',
            message.is_error === 1 && 'border-destructive/50 text-destructive'
          )}
        >
          {message.reasoning && (
            <div className="mb-2 border-l-2 border-muted pl-2 text-xs italic text-muted-foreground whitespace-pre-wrap">
              {message.reasoning}
            </div>
          )}
          {isUser ? message.content : <Markdown content={message.content} />}
        </div>
        {showActions && (
          <div className="mt-0.5 flex items-center gap-1 text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100">
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground"
              onClick={() => void copy()}
              title="复制"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? '已复制' : '复制'}
            </button>
            {message.role === 'assistant' && (
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground"
                onClick={onRegenerate}
                title="重新生成"
              >
                <RefreshCw className="h-3 w-3" /> 重新生成
              </button>
            )}
            {message.role === 'user' && (
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground"
                onClick={onEdit}
                title="编辑"
              >
                <Pencil className="h-3 w-3" /> 编辑
              </button>
            )}
            {message.role === 'user' && message.is_error === 1 && (
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                onClick={() => void useChatStore.getState().sendMessage(message.content)}
                title="发送失败,重试"
              >
                <RefreshCw className="h-3 w-3" /> 重发
              </button>
            )}
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground"
              onClick={onQuote}
              title="引用"
            >
              <MessageSquareQuote className="h-3 w-3" /> 引用
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
              title="删除"
            >
              <Trash2 className="h-3 w-3" /> 删除
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
