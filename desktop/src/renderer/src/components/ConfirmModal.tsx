import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card'
import { useApprovalsStore } from '../stores/approvals'

// 高危操作确认弹窗(架构设计 §3.4):confirm_required 事件驱动,队列串行一次一个;60s 倒计时归零自动拒绝
export default function ConfirmModal() {
  const queue = useApprovalsStore((s) => s.queue)
  const active = queue[0]
  if (!active) return null
  return <ConfirmDialog request={active} queued={queue.length - 1} />
}

function ConfirmDialog({
  request,
  queued,
}: {
  request: { request_id: string; op: string; target: string; reason: string; expiresAt: number }
  queued: number
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000)))

  useEffect(() => {
    setRemaining(Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000)))
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0) {
        clearInterval(timer)
        // 引擎侧同有 60s 超时拒绝;这里同步收掉弹窗,迟到的引擎回执是 no-op
        useApprovalsStore.getState().resolve(request.request_id, false)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [request.request_id, request.expiresAt])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> 高危操作确认
            </span>
            {remaining > 0 ? (
              <span className="text-sm font-normal text-muted-foreground">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                剩余 {remaining}s
              </span>
            ) : (
              <span className="text-sm font-normal text-destructive">即将自动拒绝</span>
            )}
          </CardTitle>
          <CardDescription>{request.reason}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">操作:</span> <span className="font-medium">{request.op}</span>
          </div>
          <div className="break-all">
            <span className="text-muted-foreground">目标:</span> {request.target}
          </div>
          {queued > 0 && <div className="text-xs text-muted-foreground">还有 {queued} 个操作等待确认</div>}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" onClick={() => useApprovalsStore.getState().resolve(request.request_id, false)}>
            拒绝
          </Button>
          <Button onClick={() => useApprovalsStore.getState().resolve(request.request_id, true)}>允许</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
