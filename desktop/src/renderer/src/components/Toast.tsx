import { CheckCircle2 } from 'lucide-react'
import { useToastStore } from '../stores/toast'

// 轻量操作反馈提示(右上角,2.5s 自动消失);shadcn 风格,替代 window.alert
export default function Toast() {
  const message = useToastStore((s) => s.message)
  if (!message) return null
  return (
    <div className="fixed right-4 top-4 z-[60] flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-md">
      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      {message}
    </div>
  )
}
