import { useEffect, useState } from 'react'
import { AlertTriangle, CircleAlert, Loader2 } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { useApprovalsStore } from '../stores/approvals'
import type { ToolCallView } from '../stores/chat'

// 工具执行卡片:tool_start/tool_end/tool_error/confirm_required 事件驱动
// pending = 审批挂起(chatbox paused 卡):内嵌批准/拒绝 + 60s 倒计时
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
  const isActiveApproval = pending && call.requestId === useApprovalsStore((s) => s.queue[0]?.request_id)
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
          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
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
        {pending && isActiveApproval && call.requestId && (
          <ApprovalActions requestId={call.requestId} />
        )}
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

// 审批按钮 + 60s 倒计时(与引擎超时一致,归零自动拒绝由 approvals store 处理)
function ApprovalActions({ requestId }: { requestId: string }) {
  const [remaining, setRemaining] = useState(() => {
    const req = useApprovalsStore.getState().queue.find((q) => q.request_id === requestId)
    return req ? Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000)) : 0
  })
  useEffect(() => {
    const timer = setInterval(() => {
      const req = useApprovalsStore.getState().queue.find((q) => q.request_id === requestId)
      if (!req) {
        clearInterval(timer)
        return
      }
      const left = Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0) {
        clearInterval(timer)
        useApprovalsStore.getState().resolve(requestId, false)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [requestId])

  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-muted-foreground">{remaining}s</span>
      <Button size="sm" variant="outline" onClick={() => useApprovalsStore.getState().resolve(requestId, false)}>
        拒绝
      </Button>
      <Button size="sm" onClick={() => useApprovalsStore.getState().resolve(requestId, true)}>
        允许
      </Button>
    </div>
  )
}
