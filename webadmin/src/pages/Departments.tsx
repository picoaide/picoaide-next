import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { deptTreeOptions } from '../lib/utils'

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

interface UserOption {
  id: number
  username: string
}

export default function Departments() {
  const [depts, setDepts] = useState<Department[]>([])
  const [users, setUsers] = useState<UserOption[]>([])
  const [error, setError] = useState('')
  const [deptDialog, setDeptDialog] = useState(false)
  const [deptForm, setDeptForm] = useState({ id: 0, name: '', parent_id: '0', leader_id: '0', description: '' })

  const load = useCallback(async () => {
    try {
      const [d, u] = await Promise.all([
        request('/api/admin/departments'),
        request('/api/admin/users?size=200'),
      ])
      setDepts(d.departments ?? [])
      setUsers(u.users ?? [])
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openDeptEdit(d?: Department) {
    setDeptForm({
      id: d?.id ?? 0,
      name: d?.name ?? '',
      parent_id: String(d?.parent_id ?? 0),
      leader_id: String(d?.leader_id ?? 0),
      description: d?.description ?? '',
    })
    setDeptDialog(true)
  }

  async function saveDeptForm() {
    const body = JSON.stringify({
      name: deptForm.name,
      parent_id: Number(deptForm.parent_id),
      leader_id: Number(deptForm.leader_id),
      description: deptForm.description,
    })
    try {
      if (deptForm.id > 0) {
        await request(`/api/admin/departments/${deptForm.id}`, { method: 'PUT', body })
      } else {
        await request('/api/admin/departments', { method: 'POST', body })
      }
      setDeptDialog(false)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function removeDept(d: Department) {
    if (!window.confirm(`确定删除部门「${d.name}」?有关联(成员/子部门/授权)时将被拒绝。`)) return
    try {
      await request(`/api/admin/departments/${d.id}`, { method: 'DELETE' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">部门管理</h1>
        <Button onClick={() => openDeptEdit()}>新建部门</Button>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      <p className="text-sm text-muted-foreground">
        金字塔架构:部门树(可嵌套)→ 部门主管 → 员工;授权给部门覆盖其子部门,主管自动继承部门及下级授权;「全员」为内置保留部门
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>部门</TableHead>
            <TableHead>上级部门</TableHead>
            <TableHead>部门主管</TableHead>
            <TableHead>成员</TableHead>
            <TableHead>子部门</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {depts.map((d) => {
            const parent = depts.find((x) => x.id === d.parent_id)
            return (
              <TableRow key={d.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {d.parent_id !== 0 && <span className="text-muted-foreground">↳</span>}
                    {d.name}
                    {d.granted_count > 0 && <Badge variant="outline">已授权</Badge>}
                  </div>
                  {d.description && <div className="text-xs text-muted-foreground">{d.description}</div>}
                </TableCell>
                <TableCell>{parent?.name ?? '—'}</TableCell>
                <TableCell>{d.leader_name || '—'}</TableCell>
                <TableCell>{d.member_count}</TableCell>
                <TableCell>{d.child_count}</TableCell>
                <TableCell className="text-right space-x-2">
                  <Button size="sm" variant="outline" onClick={() => openDeptEdit(d)}>编辑</Button>
                  <Button size="sm" variant="destructive" onClick={() => removeDept(d)}>删除</Button>
                </TableCell>
              </TableRow>
            )
          })}
          {depts.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无部门,点击「新建部门」开始搭建组织架构</TableCell></TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog open={deptDialog} onOpenChange={setDeptDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deptForm.id > 0 ? '编辑部门' : '新建部门'}</DialogTitle>
            <DialogDescription>上级部门为空 = 顶层部门;主管可为空,后续补任</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>部门名称</Label>
              <Input placeholder="如 研发部" value={deptForm.name} onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>上级部门</Label>
              <Select value={deptForm.parent_id} onValueChange={(v) => setDeptForm({ ...deptForm, parent_id: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">无(顶层部门)</SelectItem>
                  {deptTreeOptions(depts.filter((d) => d.id !== deptForm.id), 0, 0).map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>部门主管</Label>
              <Select value={deptForm.leader_id} onValueChange={(v) => setDeptForm({ ...deptForm, leader_id: v })}>
                <SelectTrigger><SelectValue placeholder="选择主管" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">未设置</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.username}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>描述(可选)</Label>
              <Input value={deptForm.description} onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })} />
            </div>
            <Button className="w-full" disabled={!deptForm.name.trim()} onClick={saveDeptForm}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
