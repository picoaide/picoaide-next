import { CircleAlert, Loader2 } from 'lucide-react'
import { Badge } from './ui/badge'
import { cn } from '../lib/utils'
import type { ToolCallView } from '../stores/chat'

// 工具执行卡片:tool_start/tool_end/tool_error 事件驱动,折叠展示 名称/输入/输出/耗时,失败标红
export default function ToolCalls({ calls }: { calls: ToolCallView[] }) {
  if (calls.length === 0) return null
  return (
    <div className="mt-2 space-y-1.5">
      {calls.map((call) => (
        <ToolCard key={call.id} call={call} />
      ))}
    </div>
  )
}

function ToolCard({ call }: { call: ToolCallView }) {
  const failed = call.status === 'error'
  return (
    <details
      className={cn(
        'group overflow-hidden rounded-md border text-xs',
        failed ? 'border-destructive/50' : 'border-border'
      )}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-2 py-1.5">
        {call.status === 'running' ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <CircleAlert className="h-3 w-3 shrink-0 text-destructive" />
        ) : (
          <Badge variant="success">✓</Badge>
        )}
        <span className={cn('font-medium', failed && 'text-destructive')}>{call.name}</span>
        <span className="ml-auto text-muted-foreground">
          {call.status === 'running'
            ? '执行中…'
            : call.error !== undefined
              ? '失败'
              : call.duration_ms !== undefined
                ? `${call.duration_ms}ms`
                : ''}
        </span>
      </summary>
      <div className="space-y-1 border-t px-2 py-1.5">
        <div>
          <div className="text-muted-foreground">输入</div>
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(call.input)}</pre>
        </div>
        {call.error !== undefined && (
          <div className="text-destructive">
            <div>错误</div>
            <pre className="whitespace-pre-wrap break-all">{call.error}</pre>
          </div>
        )}
        {call.output !== undefined && (
          <div>
            <div className="text-muted-foreground">输出</div>
            <pre className="whitespace-pre-wrap break-all">
              {typeof call.output === 'string' ? call.output : JSON.stringify(call.output, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  )
}
