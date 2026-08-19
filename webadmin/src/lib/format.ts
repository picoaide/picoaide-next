// 数字格式化与配额计算共享工具(工程原则 §3.2:重复 2 次即提取共享模块)
// 供 Users.tsx / Usage.tsx 等页面复用,统一口径避免两端不一致。

// 紧凑数字格式:>=1e6 → 1.2M,>=1e3 → 3K,去尾零(3000 → 3K)
export function fmtTokens(n: number): string {
  if (n >= 1000000) return `${Number((n / 1000000).toFixed(1))}M`
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`
  return String(n)
}

// 完整数字(千分位),用于悬浮 title 展示精确值
export function fmtFull(n: number): string {
  return n.toLocaleString()
}

// 配额使用率(0-100,clamp;quota=0/null 表示不限 → 返回 0)
export function usageRate(used: number, quota: number | null | undefined): number {
  if (!quota || quota <= 0) return 0
  return Math.min(100, Math.round((used / quota) * 100))
}

// 实际占用百分比(可 >100% 用于超额展示;quota=0/null 返回 null)
export function quotaPercent(used: number, quota: number | null | undefined): number | null {
  if (!quota || quota <= 0) return null
  return Math.round((used / quota) * 100)
}

// 是否超额(used > quota,且 quota 有限)
export function quotaOver(used: number, quota: number | null | undefined): boolean {
  return !!quota && quota > 0 && used > quota
}

// 本地时区 YYYY-MM-DD(修复 UTC 偏移一天的 bug;toISOString 在 UTC+8 上午会回退一天)
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ymdFmt 是 ymd 的别名(供 Usage 环比区间计算调用)
export const ymdFmt = ymd

// 快捷区间:相对 today 的起止日期(含 today)
export function rangePreset(days: number): { from: string; to: string } {
  const now = new Date()
  const to = ymd(now)
  const from = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)))
  return { from, to }
}

// 本月 1 日 → today
export function monthRange(): { from: string; to: string } {
  const now = new Date()
  return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) }
}

// 按日补零:从 from..to 生成连续日期序列,缺失日填 0(折线不跨缺日直连)
export function fillMissingDays(
  rows: { label: string; total: number }[],
  from: string,
  to: string
): { label: string; total: number }[] {
  if (!from || !to) return rows
  const map = new Map(rows.map((r) => [r.label, r.total]))
  const out: { label: string; total: number }[] = []
  const cur = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  for (; cur <= end; cur.setDate(cur.getDate() + 1)) {
    const key = ymd(cur)
    out.push({ label: key, total: map.get(key) ?? 0 })
  }
  return out
}
