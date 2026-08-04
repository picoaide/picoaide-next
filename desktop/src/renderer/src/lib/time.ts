// 会话更新时间的人类可读相对格式:刚刚 / N 分钟前 / N 小时前 / 昨天 / MM-DD / YYYY-MM-DD
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso.replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return ''
  const diff = now - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 172_800_000) return '昨天'
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return sameYear ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
