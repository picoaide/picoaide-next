import { useChatStore } from '../stores/chat'
import { cn } from '../lib/utils'

// 千分位缩写:12400 → 12.4k,40000 → 40k
function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n)
}

// 上下文占用条(会话头部,与 RunSteps 同区域):引擎每轮 context_usage 事件驱动,
// 字符数与压缩预算同口径(messageLength)。>80% 变 amber 提示自动摘要;运行结束清除。
export default function ContextUsage() {
  const usage = useChatStore((s) => s.contextUsage)
  if (!usage) return null
  const pct = Math.min(100, Math.round((usage.chars / usage.budget) * 100))
  const warn = usage.chars / usage.budget >= 0.8
  return (
    <div className="mx-4 mt-3" title={`${usage.chars} / ${usage.budget} 字符`}>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className={cn('tabular-nums', warn ? 'font-medium text-amber-600' : 'text-muted-foreground')}>
          {formatChars(usage.chars)}/{formatChars(usage.budget)} 字符
          {warn && <span className="ml-1">· 接近上限,将自动摘要旧消息</span>}
        </span>
        <span className="tabular-nums text-muted-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full transition-all', warn ? 'bg-amber-500' : 'bg-primary')}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  )
}
