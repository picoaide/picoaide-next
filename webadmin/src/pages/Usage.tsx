import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VChart } from '@visactor/react-vchart'
import type { ISpec } from '@visactor/vchart'
import {
  Activity, Coins, ArrowDownToLine, ArrowUpFromLine, WalletCards,
} from 'lucide-react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

interface UsageRow {
  label: string
  prompt_tokens: number
  completion_tokens: number
  requests: number
}

interface QuotaUser {
  id: number
  username: string
  is_admin: boolean
  quota_tokens: number | null
  monthly_usage: number
}

type Group = 'day' | 'model' | 'user'
type ChartTab = 'trend' | 'proportion' | 'rank'

// 紧凑数字格式:>=1e6 → 1.2M,>=1e3 → 3K(对齐 Users.tsx fmtTokens 语义)
function fmtTokens(n: number): string {
  if (n >= 1000000) return `${Number((n / 1000000).toFixed(1))}M`
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`
  return String(n)
}

function fmtFull(n: number): string {
  return n.toLocaleString()
}

// 快捷区间:相对 today 的起止日期(YYYY-MM-DD)
function rangePreset(days: number): { from: string; to: string } {
  const now = new Date()
  const to = now.toISOString().slice(0, 10)
  const from = new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10)
  return { from, to }
}

function monthRange(): { from: string; to: string } {
  const now = new Date()
  const to = now.toISOString().slice(0, 10)
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  return { from, to }
}

// 配额使用率(对齐 Users.tsx usageRate 语义;quota=0 表示不限)
function usageRate(used: number, quota: number | null | undefined): number {
  if (!quota || quota <= 0) return 0
  return Math.min(100, Math.round((used / quota) * 100))
}

// 实际占用百分比(可 >100% 用于超额展示;quota=0 返回 null)
function quotaPercent(used: number, quota: number | null | undefined): number | null {
  if (!quota || quota <= 0) return null
  return Math.round((used / quota) * 100)
}

function quotaOver(used: number, quota: number | null | undefined): boolean {
  return !!quota && quota > 0 && used > quota
}

export default function Usage() {
  const [group, setGroup] = useState<Group>('day')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rows, setRows] = useState<UsageRow[]>([])
  const [quotaUsers, setQuotaUsers] = useState<QuotaUser[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [chartTab, setChartTab] = useState<ChartTab>('trend')

  // 日期经 ref 读取:load 不被 from/to 变化重创(保持"点击查询才发请求"),
  // 同时点击时读到的永远是最新输入(审计2026-W1 旧闭包修复)
  const fromRef = useRef(from)
  const toRef = useRef(to)
  useEffect(() => {
    fromRef.current = from
    toRef.current = to
  }, [from, to])

  // 图表 Tab ↔ 分组双向联动:
  //   group 下拉变化 → chartTab 同步;chartTab 手动切换 → 重新发起对应 group 查询
  useEffect(() => {
    if (group === 'day') setChartTab('trend')
    else if (group === 'model') setChartTab('proportion')
    else setChartTab('rank')
  }, [group])

  function onChartTabChange(v: string) {
    setChartTab(v as ChartTab)
    const g: Group = v === 'trend' ? 'day' : v === 'proportion' ? 'model' : 'user'
    if (g !== group) setGroup(g)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ group })
      if (fromRef.current) params.set('from', fromRef.current)
      if (toRef.current) params.set('to', toRef.current)
      const [data, users] = await Promise.all([
        request(`/api/admin/usage?${params}`),
        request('/api/admin/users?size=200'),
      ])
      setRows(data.rows ?? [])
      // 配额面板仅统计非管理员员工(admin 由服务端豁免)
      const all: QuotaUser[] = (users.users ?? []).filter((u: QuotaUser) => !u.is_admin)
      setQuotaUsers(all)
      setError('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [group])

  // 只在分组变化或点击"查询"时加载,避免每次击键/改日期都发请求
  useEffect(() => { load() }, [load])

  function applyRange(r: { from: string; to: string }) {
    setFrom(r.from)
    setTo(r.to)
    fromRef.current = r.from
    toRef.current = r.to
    load()
  }

  // ---- 汇总统计 ----
  const totals = useMemo(() => {
    let requests = 0, prompt = 0, completion = 0
    for (const r of rows) {
      requests += r.requests
      prompt += r.prompt_tokens
      completion += r.completion_tokens
    }
    return { requests, prompt, completion, total: prompt + completion }
  }, [rows])

  // ---- 配额统计 ----
  const quotaStats = useMemo(() => {
    const tracked = quotaUsers.filter((u) => u.quota_tokens && u.quota_tokens > 0)
    const over = tracked.filter((u) => quotaOver(u.monthly_usage, u.quota_tokens))
    const near = tracked.filter((u) => !quotaOver(u.monthly_usage, u.quota_tokens) && usageRate(u.monthly_usage, u.quota_tokens) >= 90)
    const sorted = [...tracked].sort((a, b) => (b.monthly_usage / b.quota_tokens!) - (a.monthly_usage / a.quota_tokens!))
    return { tracked, over, near, sorted }
  }, [quotaUsers])

  // ---- 图表数据 ----
  const chartData = rows.map((r) => ({ label: r.label, total: r.prompt_tokens + r.completion_tokens }))
  const pieData = rows.map((r) => ({ name: r.label, value: r.prompt_tokens + r.completion_tokens }))
  const rankData = [...rows]
    .map((r) => ({ label: r.label, total: r.prompt_tokens + r.completion_tokens }))
    .sort((a, b) => b.total - a.total)

  const trendSpec: ISpec = {
    type: 'line',
    data: { values: chartData },
    xField: 'label',
    yField: 'total',
    point: { visible: true },
    axes: [
      { orient: 'left', title: { visible: true, text: 'tokens' }, label: { formatMethod: (v: any) => fmtTokens(Number(v)) } },
      { orient: 'bottom', label: { visible: true, style: { fontSize: 11 } } },
    ],
    tooltip: { visible: true },
  }

  const pieSpec: ISpec = {
    type: 'pie',
    data: { values: pieData },
    categoryField: 'name',
    valueField: 'value',
    outerRadius: 0.8,
    label: { visible: true, formatMethod: (v: any) => fmtTokens(Number(v)) },
    tooltip: { visible: true },
  }

  const rankSpec: ISpec = {
    type: 'bar',
    data: { values: rankData },
    xField: 'label',
    yField: 'total',
    axes: [
      { orient: 'left', label: { visible: true, style: { fontSize: 11 } } },
      { orient: 'bottom', title: { visible: true, text: 'tokens' }, label: { formatMethod: (v: any) => fmtTokens(Number(v)) } },
    ],
    tooltip: { visible: true },
  }

  const statCards = [
    { title: '请求数', value: totals.requests, icon: Activity, desc: '区间内 LLM 调用次数' },
    { title: '总 tokens', value: totals.total, icon: Coins, desc: '输入 + 输出' },
    { title: '输入 tokens', value: totals.prompt, icon: ArrowDownToLine, desc: 'prompt 部分' },
    { title: '输出 tokens', value: totals.completion, icon: ArrowUpFromLine, desc: 'completion 部分' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">用量统计</h1>
        <span className="text-sm text-muted-foreground">token 用量与配额对照(管理员豁免)</span>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}

      {/* 筛选区:分组 + 快捷区间 + 日期 */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div>
            <div className="mb-1 text-sm text-muted-foreground">分组</div>
            <Select value={group} onValueChange={(v) => setGroup(v as Group)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="day">按日</SelectItem>
                <SelectItem value="model">按模型</SelectItem>
                <SelectItem value="user">按用户</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <div className="mb-1 text-sm text-muted-foreground">快捷区间</div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => applyRange(rangePreset(7))}>近7天</Button>
              <Button size="sm" variant="outline" onClick={() => applyRange(rangePreset(30))}>近30天</Button>
              <Button size="sm" variant="outline" onClick={() => applyRange(monthRange())}>本月</Button>
            </div>
          </div>
          <div>
            <div className="mb-1 text-sm text-muted-foreground">起始日期</div>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <div className="mb-1 text-sm text-muted-foreground">结束日期</div>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={load}>查询</Button>
        </CardContent>
      </Card>

      {/* 汇总统计卡(对齐企业面板 stat-card 模式) */}
      <div data-testid="stat-cards" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {statCards.map((c) => (
          <Card key={c.title}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <c.icon className="h-4 w-4" />
                {c.title}
              </div>
              {loading ? (
                <Skeleton className="mt-2 h-8 w-24" />
              ) : (
                <div
                  className="mt-1 text-2xl font-bold tabular-nums tracking-tight"
                  title={fmtFull(c.value)}
                >
                  {fmtTokens(c.value)}
                </div>
              )}
              <div className="mt-1 text-xs text-muted-foreground">{c.desc}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 图表区:趋势 / 占比 / 排行(VChart) */}
      <Card>
        <Tabs value={chartTab} onValueChange={onChartTabChange}>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">用量分析</CardTitle>
              <CardDescription>Total: {fmtTokens(totals.total)} tokens</CardDescription>
            </div>
            <TabsList>
              <TabsTrigger value="trend">趋势</TabsTrigger>
              <TabsTrigger value="proportion">占比</TabsTrigger>
              <TabsTrigger value="rank">排行</TabsTrigger>
            </TabsList>
          </CardHeader>
          <CardContent>
            <TabsContent value="trend" className="h-72">
              {rows.length === 0 ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">暂无数据</div>
              ) : (
                <VChart spec={trendSpec} />
              )}
            </TabsContent>
            <TabsContent value="proportion" className="h-72">
              {rows.length === 0 ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">暂无数据</div>
              ) : (
                <VChart spec={pieSpec} />
              )}
            </TabsContent>
            <TabsContent value="rank" className="h-72">
              {rows.length === 0 ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">暂无数据</div>
              ) : (
                <VChart spec={rankSpec} />
              )}
            </TabsContent>
          </CardContent>
        </Tabs>
      </Card>

      {/* 配额占用面板 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <WalletCards className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">本月配额占用</CardTitle>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="destructive">超额 {quotaStats.over.length}</Badge>
              <Badge variant="secondary">≥90% {quotaStats.near.length}</Badge>
            </div>
          </div>
          <CardDescription>配额按月统计,每月 1 日重置;管理员豁免不参与统计</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {quotaStats.sorted.length === 0 ? (
            <div className="text-sm text-muted-foreground">暂无配额数据</div>
          ) : (
            <div data-testid="quota-list">
              {quotaStats.sorted.map((u) => {
                const rate = usageRate(u.monthly_usage, u.quota_tokens)
                const pct = quotaPercent(u.monthly_usage, u.quota_tokens)
                const over = quotaOver(u.monthly_usage, u.quota_tokens)
                return (
                  <div key={u.id} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 font-medium">
                        {u.username}
                        {over && <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">超额</Badge>}
                        {!over && rate >= 90 && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">临近</Badge>}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {pct === null ? '不限' : `${pct}%`}
                        {' · '}
                        {fmtTokens(u.monthly_usage)} / {u.quota_tokens ? fmtTokens(u.quota_tokens) : '—'}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${over ? 'bg-destructive' : rate >= 90 ? 'bg-amber-500' : 'bg-primary'}`}
                        style={{ width: `${over ? 100 : rate}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 明细表格 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">明细</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{group === 'day' ? '日期' : group === 'model' ? '模型' : '用户'}</TableHead>
                <TableHead className="text-right">请求数</TableHead>
                <TableHead className="text-right">输入 tokens</TableHead>
                <TableHead className="text-right">输出 tokens</TableHead>
                <TableHead className="text-right">合计 tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.label}>
                  <TableCell>{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTokens(r.prompt_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTokens(r.completion_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTokens(r.prompt_tokens + r.completion_tokens)}</TableCell>
                </TableRow>
              ))}
              {rows.length > 0 && (
                <TableRow className="font-semibold">
                  <TableCell>合计</TableCell>
                  <TableCell className="text-right tabular-nums">{totals.requests}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTokens(totals.prompt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTokens(totals.completion)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTokens(totals.total)}</TableCell>
                </TableRow>
              )}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
