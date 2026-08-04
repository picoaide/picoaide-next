import { CircleAlert, Loader2 } from 'lucide-react'
import { Badge } from './ui/badge'
import { cn } from '../lib/utils'
import type { ToolCallView } from '../stores/chat'

// 工具执行卡片:tool_start/tool_end/tool_error/confirm_required 事件驱动
// pending = 审批挂起:审批交互统一由全局 ConfirmModal 接管(一次一个 + 60s 倒计时),卡片只显示状态
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
  const pending = call.status === 'pending'
  return (
    <details
      open={pending}
      className={cn(
        'group overflow-hidden rounded-md border text-xs',
        failed ? 'border-destructive/50' : pending ? 'border-amber-500/50 bg-amber-500/5' : 'border-border'
      )}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-2 py-1.5">
        {call.status === 'running' ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <CircleAlert className="h-3 w-3 shrink-0 text-destructive" />
        ) : pending ? (
          <CircleAlert className="h-3 w-3 shrink-0 text-amber-500" />
        ) : (
          <Badge variant="success">✓</Badge>
        )}
        <span className={cn('font-medium', failed ? 'text-destructive' : pending && 'text-amber-600')}>
          {call.name}
        </span>
        <span className="ml-auto text-muted-foreground">
          {pending ? '等待批准' : call.status === 'running' ? '执行中…' : call.error !== undefined ? '失败' : call.duration_ms !== undefined ? `${call.duration_ms}ms` : ''}
        </span>
      </summary>
      <div className="space-y-1 border-t px-2 py-1.5">
        {pending && call.reason && <div className="text-amber-600">{call.reason}</div>}
        {pending && call.target && (
          <div className="break-all text-muted-foreground">
            <span>目标:</span> {call.target}
          </div>
        )}
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
