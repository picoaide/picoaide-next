import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Switch } from '../components/ui/switch'

interface User {
  id: number
  username: string
  is_admin: boolean
  status: number
}

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (p: number) => {
    try {
      const data = await request(`/api/admin/users?page=${p}&size=20`)
      setUsers(data.users)
      setTotal(data.total)
      setPage(p)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load(1) }, [load])

  async function create() {
    try {
      await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, is_admin: isAdmin }),
      })
      setCreateOpen(false)
      setUsername('')
      setPassword('')
      setIsAdmin(false)
      load(1)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function toggleUser(u: User) {
    try {
      await request(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: u.status === 1 ? 0 : 1 }),
      })
      load(page)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function remove(u: User) {
    if (!window.confirm(`确定删除用户 ${u.username}?`)) return
    try {
      await request(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      load(page)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const pages = Math.max(1, Math.ceil(total / 20))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">用户管理</h1>
        <Button onClick={() => setCreateOpen(true)}>新建用户</Button>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>用户名</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.id}</TableCell>
              <TableCell>{u.username}</TableCell>
              <TableCell>{u.is_admin ? <Badge>管理员</Badge> : <Badge variant="secondary">员工</Badge>}</TableCell>
              <TableCell>{u.status === 1 ? <Badge variant="success">启用</Badge> : <Badge variant="destructive">禁用</Badge>}</TableCell>
              <TableCell className="text-right space-x-2">
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
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => load(page - 1)}>上一页</Button>
        <span className="text-sm text-muted-foreground">第 {page}/{pages} 页 · 共 {total} 人</span>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => load(page + 1)}>下一页</Button>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>创建本地账号</DialogDescription>
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
    </div>
  )
}
