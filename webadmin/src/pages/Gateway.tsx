import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Switch } from '../components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'

interface Provider {
  id: number
  name: string
  base_url: string
  api_key: string
  models: string[]
  enabled: boolean
}

interface Model {
  id: number
  name: string
  display_name: string
}

export default function Gateway() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [cfg, setCfg] = useState({ default_model: '', rate_limit: '60', allow_private: false, search_endpoint: '', server_base_url: '' })
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')

  const [provDialog, setProvDialog] = useState(false)
  const [provForm, setProvForm] = useState({ name: '', base_url: '', api_key: '', models: '' })
  const [modelDialog, setModelDialog] = useState(false)
  const [modelForm, setModelForm] = useState({ name: '', provider_id: '', display_name: '' })

  const load = useCallback(async () => {
    try {
      const [p, m, g] = await Promise.all([
        request('/api/admin/providers'),
        request('/api/admin/models'),
        request('/api/admin/gateway'),
      ])
      setProviders(p.providers ?? [])
      setModels(m.models ?? [])
      setCfg(g)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function saveGateway() {
    try {
      await request('/api/admin/gateway', { method: 'PUT', body: JSON.stringify(cfg) })
      setOkMsg('已保存')
      setTimeout(() => setOkMsg(''), 2000)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function createProvider() {
    try {
      await request('/api/admin/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: provForm.name,
          base_url: provForm.base_url,
          api_key: provForm.api_key,
          models: provForm.models.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      })
      setProvDialog(false)
      setProvForm({ name: '', base_url: '', api_key: '', models: '' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function createModel() {
    try {
      await request('/api/admin/models', {
        method: 'POST',
        body: JSON.stringify({ ...modelForm, provider_id: Number(modelForm.provider_id) }),
      })
      setModelDialog(false)
      setModelForm({ name: '', provider_id: '', display_name: '' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function deleteProvider(id: number) {
    if (!window.confirm('删除该上游?其模型将一并删除')) return
    try {
      await request(`/api/admin/providers/${id}`, { method: 'DELETE' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function deleteModel(id: number) {
    try {
      await request(`/api/admin/models/${id}`, { method: 'DELETE' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">网关配置</h1>
      {error && <div className="text-sm text-destructive">{error}</div>}
      {okMsg && <div className="text-sm text-green-600">{okMsg}</div>}

      <Card>
        <CardHeader>
          <CardTitle>全局设置</CardTitle>
          <CardDescription>默认模型与 web 工具配置,随客户端启动配置下发</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>默认模型</Label>
              <Select value={cfg.default_model} onValueChange={(v) => setCfg({ ...cfg, default_model: v })}>
                <SelectTrigger><SelectValue placeholder="选择默认模型" /></SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.name}>{m.display_name || m.name} ({m.name})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>每用户网关限流(次/分钟)</Label>
              <Input value={cfg.rate_limit} onChange={(e) => setCfg({ ...cfg, rate_limit: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center gap-2">
              <Switch checked={cfg.allow_private} onCheckedChange={(v) => setCfg({ ...cfg, allow_private: v })} />
              <Label>允许 web_fetch 访问私有网段</Label>
            </div>
            <div className="space-y-1">
              <Label>web_search 端点</Label>
              <Input placeholder="https://search.example.com/q" value={cfg.search_endpoint}
                onChange={(e) => setCfg({ ...cfg, search_endpoint: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>对外访问地址 (Server Base URL)</Label>
            <Input placeholder="https://picoaide.example.com" value={cfg.server_base_url}
              onChange={(e) => setCfg({ ...cfg, server_base_url: e.target.value })} />
            <p className="text-xs text-muted-foreground">
              客户端登录与员工访问入口(经 Caddy HTTPS 反代后的地址);填写后管理页顶部展示
            </p>
          </div>
          <Button onClick={saveGateway}>保存</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>上游 Provider</CardTitle>
          <CardDescription>LLM 上游密钥只存服务端(AES-GCM 加密)</CardDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setProvDialog(true)}>添加上游</Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>API Key</TableHead>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell className="font-mono text-xs">{p.base_url}</TableCell>
                  <TableCell>{p.api_key || '(未设置)'}</TableCell>
                  <TableCell>{p.models.join(', ')}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="destructive" onClick={() => deleteProvider(p.id)}>删除</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型管理</CardTitle>
          <CardDescription>对客户端可见的模型列表</CardDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setModelDialog(true)}>新增模型</Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型名</TableHead>
                <TableHead>显示名</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono">{m.name}</TableCell>
                  <TableCell>{m.display_name}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="destructive" onClick={() => deleteModel(m.id)}>删除</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={provDialog} onOpenChange={setProvDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>添加上游</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>名称(如 deepseek)</Label>
              <Input value={provForm.name} onChange={(e) => setProvForm({ ...provForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Base URL(如 https://api.deepseek.com)</Label>
              <Input value={provForm.base_url} onChange={(e) => setProvForm({ ...provForm, base_url: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>API Key</Label>
              <Input type="password" value={provForm.api_key} onChange={(e) => setProvForm({ ...provForm, api_key: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>模型(逗号分隔)</Label>
              <Input value={provForm.models} onChange={(e) => setProvForm({ ...provForm, models: e.target.value })} />
            </div>
            <Button className="w-full" onClick={createProvider}>添加</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={modelDialog} onOpenChange={setModelDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>新增模型</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>模型名(如 deepseek-chat)</Label>
              <Input value={modelForm.name} onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>显示名</Label>
              <Input value={modelForm.display_name} onChange={(e) => setModelForm({ ...modelForm, display_name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>所属上游</Label>
              <Select value={modelForm.provider_id} onValueChange={(v) => setModelForm({ ...modelForm, provider_id: v })}>
                <SelectTrigger><SelectValue placeholder="选择上游" /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" onClick={createModel}>新增</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
