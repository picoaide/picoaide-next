import { FolderOpen } from 'lucide-react'
import { picoaide } from '../api/picoaide'
import type { ArtifactRow } from '../../../main/ipc'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { basename } from '../lib/utils'

// 右侧产物面板(架构设计 §3.5):当前会话产物列表 + "在文件夹中显示"
export default function ArtifactsPanel({ artifacts }: { artifacts: ArtifactRow[] }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-l bg-muted/20">
      <div className="border-b px-3 py-2 text-sm font-medium">产物</div>
      {artifacts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-3 text-xs text-muted-foreground">暂无产物</div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="space-y-1.5 p-2">
            {artifacts.map((a) => (
              <div key={a.id} className="rounded-md border bg-background px-2 py-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-xs" title={a.path}>
                    {basename(a.path)}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {a.type}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-6 w-full justify-start px-1 text-xs text-muted-foreground"
                  title={a.path}
                  onClick={() => void picoaide().artifactShowInFolder(a.path)}
                >
                  <FolderOpen className="h-3 w-3" /> 在文件夹中显示
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </aside>
  )
}
