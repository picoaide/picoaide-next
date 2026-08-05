import { CircleCheck, CircleX, Loader2 } from 'lucide-react'
import { Badge } from './ui/badge'
import { cn } from '../lib/utils'
import { useChatStore, type RunStep } from '../stores/chat'

// 执行轨迹条(会话头部):最近一轮运行的步骤序列,由 tool_start/tool_end/tool_error 事件驱动。
// 运行中:步骤胶囊横排(超出横向滚动),进行中高亮/失败标红;
// 结束后折叠为一行"✓ 完成(N 步)"(runStepCount 保留,runSteps 已清空)。
// 无步骤且无历史计数 → 不渲染(历史会话加载/无工具运行零侵入)
export default function RunSteps() {
  const steps = useChatStore((s) => s.runSteps)
  const count = useChatStore((s) => s.runStepCount)
  if (steps.length === 0 && count === 0) return null
  return (
    <div className="mx-4 mt-3">
      {steps.length === 0 ? (
        <Badge variant="success" className="gap-1">
          <CircleCheck className="h-3 w-3" /> 完成({count} 步)
        </Badge>
      ) : (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {steps.map((step, i) => (
            <StepPill key={step.id} step={step} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

function StepPill({ step, index }: { step: RunStep; index: number }) {
  const running = step.status === 'running'
  const failed = step.status === 'error'
  return (
    <Badge
      variant={failed ? 'destructive' : running ? 'default' : 'outline'}
      className={cn('shrink-0 gap-1.5', running && 'animate-pulse')}
      title={`${index + 1}. ${step.toolName}${step.durationMs !== undefined ? `(${step.durationMs}ms)` : ''}`}
    >
      <span className="text-[10px] tabular-nums opacity-70">{index + 1}</span>
      {running ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : failed ? (
        <CircleX className="h-3 w-3" />
      ) : (
        <CircleCheck className="h-3 w-3" />
      )}
      <span className="max-w-40 truncate font-medium">{step.toolName}</span>
    </Badge>
  )
}
