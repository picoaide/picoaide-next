import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { useChatStore } from '../stores/chat'

interface SearchResult {
  conversationId: number
  title: string
  snippet: string
}

// chatbox SearchDialog(Cmd+P):会话标题 + 消息内容搜索,点击跳转会话
export default function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!query.trim()) {
      setResults([])
      return
    }
    setBusy(true)
    let canceled = false
    window.picoaide
      .chatSearch(query)
      .then((r) => {
        if (!canceled) setResults(r)
        setBusy(false)
      })
      .catch(() => {
        if (!canceled) setBusy(false)
      })
    return () => {
      canceled = true
    }
  }, [query, open])

  const jump = (conversationId: number) => {
    void useChatStore.getState().selectConversation(conversationId)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="top-[15%] max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">搜索会话</DialogTitle>
          <DialogDescription>按会话标题或消息内容搜索(Enter 或点击跳转)</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            className="pl-8"
            placeholder="输入关键词…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results.length > 0) jump(results[0].conversationId)
            }}
          />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {busy && <div className="py-2 text-sm text-muted-foreground">搜索中…</div>}
          {!busy && results.length === 0 && query.trim() !== '' && (
            <div className="py-2 text-sm text-muted-foreground">无结果</div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.conversationId}-${i}`}
              type="button"
              className="block w-full rounded-md px-3 py-2 text-left hover:bg-accent"
              onClick={() => jump(r.conversationId)}
            >
              <div className="truncate text-sm font-medium">{r.title}</div>
              {r.snippet && <div className="truncate text-xs text-muted-foreground">{r.snippet}</div>}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
