import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Switch } from '../components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'

interface User {
  id: number
  username: string
  is_admin: boolean
  status: number
  groups?: string[]
  quota_tokens?: number | null // null = follow global default, 0 = unlimited, >0 = monthly cap
  monthly_usage?: number // tokens used this calendar month
}

interface Department {
  id: number
  name: string
  parent_id: number
  leader_id: number
  leader_name: string
  description: string
  member_count: number
  child_count: number
  granted_count: number
}

interface ApiToken {
  id: number
  name: string
  created_at: string
  expires_at: string
  last_used_at: string
  revoked: number
}

function fmtTime(s: string): string {
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}

function fmtTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

// quotaLabel renders the effective monthly quota for a user row.
function quotaLabel(q: number | null | undefined): string {
  if (q === null || q === undefined) return '跟随默认'
  if (q === 0) return '不限'
  return `${fmtTokens(q)} / 月`
}

function usageRate(used: number, quota: number | null | undefined): number {
  if (!quota || quota <= 0) return 0
  return Math.min(100, Math.round((used / quota) * 100))
}

// 部门树选项(缩进层级显示):平铺 → "研发部"、"研发部 / 前端组"
function deptOptions(depts: Department[], parentId: number, depth: number): { id: number; label: string }[] {
  const out: { id: number; label: string }[] = []
  for (const d of depts) {
    if (d.parent_id !== parentId) continue
    const prefix = depth > 0 ? `${'　'.repeat(depth)}↳ ` : ''
    out.push({ id: d.id, label: `${prefix}${d.name}` })
    out.push(...deptOptions(depts, d.id, depth + 1))
  }
  return out
}

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [depts, setDepts] = useState<Department[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState('')
  const [tokensUser, setTokensUser] = useState<User | null>(null)
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [deptUser, setDeptUser] = useState<User | null>(null)
  const [deptSelect, setDeptSelect] = useState('0')
  const [quotaUser, setQuotaUser] = useState<User | null>(null)
  const [quotaInput, setQuotaInput] = useState('')

  const load = useCallback(async (p: number, search: string) => {
    try {
      const params = new URLSearchParams({ page: String(p), size: '20' })
      if (search) params.set('q', search)
      const [u, d] = await Promise.all([
        request(`/api/admin/users?${params}`),
        request('/api/admin/departments'),
      ])
      setUsers(u.users)
      setTotal(u.total)
      setDepts(d.departments ?? [])
      setPage(p)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load(1, '') }, [load])

  async function create() {
    if (busy) return // 双击守卫(审计2026-W9)
    setBusy(true)
    try {
      await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, is_admin: isAdmin }),
      })
      setCreateOpen(false)
      setUsername('')
      setPassword('')
      setIsAdmin(false)
      load(1, "")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleUser(u: User) {
    if (busy) return // 双击守卫(审计2026-W9)
    setBusy(true)
    try {
      await request(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: u.status === 1 ? 0 : 1 }),
      })
      load(page, q)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(u: User) {
    if (busy) return // 双击守卫(审计2026-W9)
    if (!window.confirm(`确定删除用户 ${u.username}?`)) return
    setBusy(true)
    try {
      await request(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      load(page, q)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function openTokens(u: User) {
    setTokensUser(u)
    try {
      const data = await request(`/api/admin/users/${u.id}/tokens`)
      setTokens(data.tokens)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function revoke(t: ApiToken) {
    if (!window.confirm(`确定撤销令牌 #${t.id}(${t.name})?撤销后客户端需重新登录。`)) return
    try {
      await request(`/api/admin/tokens/${t.id}/revoke`, { method: 'POST' })
      if (tokensUser) openTokens(tokensUser)
    } catch (err: any) {
      setError(err.message)
    }
  }

  // ---- 员工部门归属(金字塔单选,从部门树选择) ----
  async function openDept(u: User) {
    setDeptUser(u)
    const current = (u.groups ?? [])[0]
    const d = depts.find((x) => x.name === current)
    setDeptSelect(d ? String(d.id) : '0')
  }

  async function saveDept() {
    if (!deptUser) return
    try {
      await request(`/api/admin/users/${deptUser.id}/department`, {
        method: 'PUT',
        body: JSON.stringify({ group_id: Number(deptSelect) }),
      })
      setDeptUser(null)
      load(page, q)
    } catch (err: any) {
      setError(err.message)
    }
  }

  // ---- 员工流量配额(跟随全局 / 不限 / 按月限额) ----
  function openQuota(u: User) {
    setQuotaUser(u)
    setQuotaInput(u.quota_tokens === null || u.quota_tokens === undefined ? '' : String(u.quota_tokens))
  }

  async function saveQuota() {
    if (!quotaUser) return
    const v = quotaInput.trim()
    try {
      // 空 = 跟随全局默认(清空覆盖);"0" = 不限;正数 = 月配额
      await request(`/api/admin/users/${quotaUser.id}`, {
        method: 'PUT',
        body: JSON.stringify(v === '' ? { quota_clear: true } : { quota_tokens: Number(v) }),
      })
      setQuotaUser(null)
      load(page, q)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const pages = Math.max(1, Math.ceil(total / 20))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">用户管理</h1>
        <div className="flex items-center gap-2">
          <Input
            className="w-56"
            placeholder="按用户名搜索…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(1, q)}
          />
          <Button variant="outline" onClick={() => load(1, q)}>搜索</Button>
          <Button onClick={() => setCreateOpen(true)}>新建用户</Button>
        </div>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>用户名</TableHead>
            <TableHead>部门</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>本月流量</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.id}</TableCell>
              <TableCell>{u.username}</TableCell>
              <TableCell>
                {(u.groups ?? []).length > 0
                  ? u.groups!.map((g) => <Badge key={g} variant="outline" className="mr-1">{g}</Badge>)
                  : <span className="text-xs text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>{u.is_admin ? <Badge>管理员</Badge> : <Badge variant="secondary">员工</Badge>}</TableCell>
              <TableCell>{u.status === 1 ? <Badge variant="success">启用</Badge> : <Badge variant="destructive">禁用</Badge>}</TableCell>
              <TableCell>
                {u.is_admin ? (
                  <span className="text-xs text-muted-foreground">豁免</span>
                ) : (
                  <div className="space-y-0.5">
                    <div className="text-xs">
                      <span className="font-medium">{fmtTokens(u.monthly_usage ?? 0)}</span>
                      <span className="text-muted-foreground"> / {quotaLabel(u.quota_tokens)}</span>
                    </div>
                    {u.quota_tokens && u.quota_tokens > 0 && (
                      <Badge
                        variant={usageRate(u.monthly_usage ?? 0, u.quota_tokens) >= 90 ? 'destructive' : 'secondary'}
                        className="h-4 px-1.5 text-[10px]"
                      >
                        {usageRate(u.monthly_usage ?? 0, u.quota_tokens)}%
                      </Badge>
                    )}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right space-x-2">
                <Button size="sm" variant="outline" onClick={() => openTokens(u)}>令牌</Button>
                <Button size="sm" variant="outline" onClick={() => openDept(u)}>部门</Button>
                <Button size="sm" variant="outline" onClick={() => openQuota(u)}>配额</Button>
                <Button size="sm" variant="outline" onClick={() => toggleUser(u)}>
                  {u.status === 1 ? '禁用' : '启用'}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => remove(u)}>删除</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => load(page - 1, q)}>上一页</Button>
        <span className="text-sm text-muted-foreground">第 {page}/{pages} 页 · 共 {total} 人</span>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => load(page + 1, q)}>下一页</Button>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>创建本地账号,创建后在「部门」中设置归属</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>用户名</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>密码</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isAdmin} onCheckedChange={setIsAdmin} />
              <Label>管理员</Label>
            </div>
            <Button onClick={create} className="w-full">创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 员工部门归属(金字塔单选) */}
      <Dialog open={!!deptUser} onOpenChange={(open) => { if (!open) setDeptUser(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置部门 · {deptUser?.username}</DialogTitle>
            <DialogDescription>从部门树选择归属(单选);授权给上级部门自动覆盖本部门</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>部门</Label>
              <Select value={deptSelect} onValueChange={setDeptSelect}>
                <SelectTrigger><SelectValue placeholder="选择部门" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">未分配</SelectItem>
                  {deptOptions(depts, 0, 0).map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={saveDept} className="w-full">保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 员工流量配额(跟随默认 / 不限 / 按月限额) */}
      <Dialog open={!!quotaUser} onOpenChange={(open) => { if (!open) setQuotaUser(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>流量配额 · {quotaUser?.username}</DialogTitle>
            <DialogDescription>
              本月已用 {fmtTokens(quotaUser?.monthly_usage ?? 0)} tokens。配额按月统计,每月 1 日重置。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>月度配额(token 数)</Label>
              <Input
                type="number"
                min={0}
                placeholder="留空 = 跟随全局默认;0 = 不限"
                value={quotaInput}
                onChange={(e) => setQuotaInput(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              留空:跟随网关「全局设置」中的默认月配额;输入 0:该员工不限流量;输入正数:按月限额。管理员(admin)不受配额限制。
            </p>
            <Button className="w-full" onClick={saveQuota}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!tokensUser} onOpenChange={(open) => { if (!open) setTokensUser(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>令牌管理 · {tokensUser?.username}</DialogTitle>
            <DialogDescription>客户端登录凭证,90 天过期;撤销后客户端需重新登录</DialogDescription>
          </DialogHeader>
          {tokens.length === 0 ? (
            <div className="text-sm text-muted-foreground">该用户暂无令牌</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>最后使用</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{t.name}</TableCell>
                    <TableCell>{fmtTime(t.created_at)}</TableCell>
                    <TableCell>{fmtTime(t.expires_at)}</TableCell>
                    <TableCell>{fmtTime(t.last_used_at)}</TableCell>
                    <TableCell>{t.revoked ? <Badge variant="destructive">已撤销</Badge> : <Badge variant="success">正常</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="destructive" disabled={!!t.revoked} onClick={() => revoke(t)}>撤销</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
