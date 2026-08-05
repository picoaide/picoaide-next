import { useEffect, useState } from 'react'
import { RefreshCcw } from 'lucide-react'
import { picoaide } from '../api/picoaide'
import type { ArtifactReadResult, ArtifactRow } from '../../../main/ipc'
import { useChatStore } from '../stores/chat'
import { basename } from '../lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { ScrollArea } from './ui/scroll-area'
import Markdown from './Markdown'

// 产物预览(4-A):按 artifact:read 返回的 kind 渲染 HTML(沙箱 iframe)/图片/文本,
// 并提供"继续修改"回灌按钮(拼路径为用户消息走 sendMessage)
export default function ArtifactPreview({
  artifact,
  onClose,
}: {
  artifact: ArtifactRow
  onClose: () => void
}) {
  const [result, setResult] = useState<ArtifactReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    setError(null)
    picoaide()
      .artifactRead(artifact.path)
      .then((r) => {
        if (!cancelled) setResult(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '预览加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [artifact.path])

  const continueEditing = (): void => {
    onClose()
    void useChatStore.getState().requestEditArtifact(artifact.path)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="truncate" title={artifact.path}>
              {basename(artifact.path)}
            </span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {artifact.type}
            </Badge>
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{artifact.path}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="pr-4">
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : !result ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : result.kind === 'html' ? (
              <iframe sandbox="" title="artifact-preview" srcDoc={result.content} className="h-[55vh] w-full rounded-md border bg-white" />
            ) : result.kind === 'image' ? (
              // img 加载 SVG 不执行脚本(浏览器安全语义),图片渲染无需额外沙箱
              <img src={result.dataUrl} alt={basename(artifact.path)} className="mx-auto max-h-[55vh] max-w-full rounded-md border object-contain" />
            ) : result.kind === 'md' ? (
              <Markdown content={result.content ?? ''} />
            ) : result.kind === 'text' ? (
              <pre className="h-[55vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">
                {result.content}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">该文件类型暂不支持预览,可在文件夹中查看。</p>
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button onClick={continueEditing}>
            <RefreshCcw className="h-4 w-4" /> 继续修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
