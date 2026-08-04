import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { Check, Copy, FileText, MessageSquareQuote, Pencil, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'
import ToolCalls from './ToolCalls'
import Markdown from './Markdown'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { useChatStore, type ChatMessage, type ToolCallView } from '../stores/chat'
import ConfirmDialog from './ConfirmDialog'

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
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  useEffect(() => {
    // 新消息/切会话后滚到底;rAF 延迟到 ScrollArea 布局完成,否则 scrollIntoView 会落到旧高度
    if (!nearBottom.current) return
    const raf = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
    return () => cancelAnimationFrame(raf)
  }, [messages, streamingText, streamingReasoning, toolCalls])

  if (messages.length === 0 && !streaming && !error) {
    const EXAMPLES: { icon: typeof FileText; title: string; prompt: string }[] = [
      { icon: FileText, title: '整理文档', prompt: '帮我总结 /tmp 下的周报文件,输出要点清单' },
      { icon: RefreshCw, title: '处理表格', prompt: '读取工作目录里的 Excel,按部门汇总销售额' },
      { icon: Trash2, title: '清理文件', prompt: '列出工作目录中的临时文件,确认后删除' },
      { icon: Sparkles, title: '生成报告', prompt: '根据最近的对话内容生成一份项目周报' },
    ]
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
        <div className="text-center">
          <h2 className="text-lg font-semibold">开始与 PicoAide 对话吧</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Agent 运行在本机,可安全操作你的文件、终端与浏览器
          </p>
        </div>
        <div className="grid w-full max-w-xl grid-cols-2 gap-3">
          {EXAMPLES.map((e) => (
            <button
              key={e.title}
              type="button"
              className="group rounded-md border bg-card p-3 text-left text-sm transition-colors hover:border-ring hover:bg-accent"
              onClick={() => useChatStore.getState().applyPrompt(e.prompt)}
            >
              <div className="flex items-center gap-2 font-medium">
                <e.icon className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
                {e.title}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{e.prompt}</p>
            </button>
          ))}
        </div>
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
        <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 break-words">{error}</span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={regenerate}
            title="重新发送最后一条消息"
          >
            <RefreshCw className="h-3 w-3" /> 重试
          </Button>
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
                  setConfirmDeleteId(m.id)
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
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="删除消息"
        description="删除后消息将不可恢复。"
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId !== null) void useChatStore.getState().deleteMessage(confirmDeleteId)
        }}
      />
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
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs font-normal" onClick={() => void copy()}>
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? '已复制' : '复制'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>复制消息内容</TooltipContent>
              </Tooltip>
              {message.role === 'assistant' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs font-normal" onClick={onRegenerate}>
                      <RefreshCw className="h-3 w-3" /> 重新生成
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>截断并重跑最后一条消息</TooltipContent>
                </Tooltip>
              )}
              {message.role === 'user' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs font-normal" onClick={onEdit}>
                      <Pencil className="h-3 w-3" /> 编辑
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>修改后重新生成回复</TooltipContent>
                </Tooltip>
              )}
              {message.role === 'user' && message.is_error === 1 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs font-normal text-destructive hover:bg-destructive/10" onClick={() => void useChatStore.getState().sendMessage(message.content)}>
                      <RefreshCw className="h-3 w-3" /> 重发
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>发送失败,点击重试</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs font-normal" onClick={onQuote}>
                    <MessageSquareQuote className="h-3 w-3" /> 引用
                  </Button>
                </TooltipTrigger>
                <TooltipContent>以引用格式插入输入框</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs font-normal hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}>
                    <Trash2 className="h-3 w-3" /> 删除
                  </Button>
                </TooltipTrigger>
                <TooltipContent>删除这条消息</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
      </div>
    </div>
  )
}
