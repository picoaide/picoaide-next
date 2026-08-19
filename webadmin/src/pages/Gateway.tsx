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
import { Badge } from '../components/ui/badge'

interface Provider {
  id: number
  name: string
  base_url: string
  api_key: string
  models: string[]
  enabled: boolean
  channel: string
}

interface Channel {
  name: string
  base_url: string
}

interface Model {
  id: number
  name: string
  display_name: string
  default_params: string
  input_price_per_1m?: number | null // 0022:元/百万 token,nil = 未定价
  output_price_per_1m?: number | null
  offpeak_discount?: number | null // 0023:0<d<1 低谷折扣;nil/1 = 无峰谷价
}

function formatCaps(defaultParams: string): string {
  try {
    const p = JSON.parse(defaultParams)
    const fmt = (n?: number) => {
      if (!n) return ''
      if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}M`
      if (n % 1024 === 0) return `${n / 1024}K`
      return `${Math.round(n / 1024)}K`
    }
    const cl = fmt(p.context_length)
    const mo = fmt(p.max_output)
    if (cl && mo) return `${cl} / ${mo}`
    return cl || mo || '-'
  } catch {
    return '-'
  }
}

export default function Gateway() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [cfg, setCfg] = useState({ default_model: '', rate_limit: '60', monthly_quota: '0', monthly_quota_money: '0', allow_private: false, search_endpoint: '', server_base_url: '' })
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [syncMsg, setSyncMsg] = useState('')

  const [provDialog, setProvDialog] = useState(false)
  const [provForm, setProvForm] = useState({ name: '', channel: '', base_url: '', api_key: '', models: '' })
  const [modelDialog, setModelDialog] = useState(false)
  const [modelForm, setModelForm] = useState({ name: '', provider_id: '', display_name: '', input_price_per_1m: '', output_price_per_1m: '', offpeak_discount: '' })

  const load = useCallback(async () => {
    try {
      const [p, m, g, ch] = await Promise.all([
        request('/api/admin/providers'),
        request('/api/admin/models'),
        request('/api/admin/gateway'),
        request('/api/admin/channels'),
      ])
      setProviders(p.providers ?? [])
      setModels(m.models ?? [])
      setCfg(g)
      setChannels(ch.channels ?? [])
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
      const r = await request('/api/admin/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: provForm.name,
          channel: provForm.channel,
          base_url: provForm.base_url,
          api_key: provForm.api_key,
          models: provForm.models.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      })
      const sync = r.sync
      if (sync?.error) {
        setError(`已保存,但模型同步失败:${sync.error}(可稍后点"立即同步"重试)`)
      } else if (sync && sync.added > 0) {
        setSyncMsg(`已上架 ${sync.added} 个模型(移除 ${sync.removed ?? 0})`)
      } else if (sync) {
        setSyncMsg('已保存,上游未返回新模型')
      } else {
        setOkMsg('已保存')
      }
      setProvDialog(false)
      setProvForm({ name: '', channel: '', base_url: '', api_key: '', models: '' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function createModel() {
    // 未选上游直接提示(审计2026-W10),不把 provider_id=0 提交给服务端
    if (!modelForm.provider_id) {
      setError('请选择所属上游')
      return
    }
    try {
      const body: Record<string, any> = {
        name: modelForm.name,
        provider_id: Number(modelForm.provider_id),
        display_name: modelForm.display_name,
      }
      // 价格留空 = 未定价(NULL);输入 0 = 定价 0(等价未定价);正数 = 元/百万 token
      if (modelForm.input_price_per_1m.trim() !== '') body.input_price_per_1m = Number(modelForm.input_price_per_1m)
      if (modelForm.output_price_per_1m.trim() !== '') body.output_price_per_1m = Number(modelForm.output_price_per_1m)
      // 低谷折扣(0023):留空 = 无峰谷价;0<d<1 = 低谷窗口内 ×d
      if (modelForm.offpeak_discount.trim() !== '') body.offpeak_discount = Number(modelForm.offpeak_discount)
      await request('/api/admin/models', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setModelDialog(false)
      setModelForm({ name: '', provider_id: '', display_name: '', input_price_per_1m: '', output_price_per_1m: '', offpeak_discount: '' })
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
    if (!window.confirm('删除该模型?客户端建议清单将移除。')) return
    try {
      await request(`/api/admin/models/${id}`, { method: 'DELETE' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  // 模型编辑:价格补录/修改(0022 金额计费前提 + 0023 峰谷折扣);其余字段留空不覆盖
  const [editModel, setEditModel] = useState<Model | null>(null)
  const [editPriceForm, setEditPriceForm] = useState({ input: '', output: '', offpeak: '' })
  function openModelPricing(m: Model) {
    setEditModel(m)
    setEditPriceForm({
      input: m.input_price_per_1m === null || m.input_price_per_1m === undefined ? '' : String(m.input_price_per_1m),
      output: m.output_price_per_1m === null || m.output_price_per_1m === undefined ? '' : String(m.output_price_per_1m),
      offpeak: m.offpeak_discount === null || m.offpeak_discount === undefined ? '' : String(m.offpeak_discount),
    })
  }
  async function saveModelPricing() {
    if (!editModel) return
    try {
      const body: Record<string, any> = { name: editModel.name }
      // 留空 = 保持现值(服务端对缺省字段不覆盖);输入 0 = 定价 0(计费为 0)
      if (editPriceForm.input.trim() !== '') body.input_price_per_1m = Number(editPriceForm.input)
      if (editPriceForm.output.trim() !== '') body.output_price_per_1m = Number(editPriceForm.output)
      if (editPriceForm.offpeak.trim() !== '') body.offpeak_discount = Number(editPriceForm.offpeak)
      await request(`/api/admin/models/${editModel.id}`, { method: 'PUT', body: JSON.stringify(body) })
      setEditModel(null)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function syncAll() {
    try {
      const r = await request('/api/admin/providers/sync-all', { method: 'POST' })
      const results: { provider: string; added: number; removed: number; error?: string }[] = r.results ?? []
      const summary = results
        .map((x) => (x.error ? `${x.provider}: ${x.error}` : `${x.provider}: +${x.added}/-${x.removed}`))
        .join('; ')
      setSyncMsg(summary || '没有可同步的上游')
      setTimeout(() => setSyncMsg(''), 4000)
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
      {syncMsg && <div className="text-sm text-green-600">{syncMsg}</div>}

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
            <div className="space-y-1">
              <Label>每用户默认月配额(token)</Label>
              <Input value={cfg.monthly_quota} onChange={(e) => setCfg({ ...cfg, monthly_quota: e.target.value })} />
              <p className="text-xs text-muted-foreground">0 = 不限;员工默认按月统计,可在用户页单独覆盖</p>
            </div>
            <div className="space-y-1">
              <Label>每用户默认月金额配额(元)</Label>
              <Input value={cfg.monthly_quota_money} onChange={(e) => setCfg({ ...cfg, monthly_quota_money: e.target.value })} />
              <p className="text-xs text-muted-foreground">
                0 = 不限;按模型定价折算费用统计,可在用户页单独覆盖
              </p>
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
                <TableHead>渠道</TableHead>
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
                  <TableCell>{p.channel ? <Badge variant="secondary">{p.channel}</Badge> : '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{p.base_url}</TableCell>
                  <TableCell>{p.api_key ? (p.api_key === '***' ? '已设置(隐藏)' : p.api_key) : '(未设置)'}</TableCell>
                  <TableCell>
                    {p.channel ? <span className="text-xs text-muted-foreground">自动同步</span> : p.models.join(', ')}
                  </TableCell>
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
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={syncAll}>立即同步</Button>
            <Button size="sm" onClick={() => setModelDialog(true)}>新增模型</Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型名</TableHead>
                <TableHead>显示名</TableHead>
                <TableHead>能力</TableHead>
                <TableHead>价格(元/百万 token)</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => {
                const priced = (m.input_price_per_1m ?? 0) > 0 || (m.output_price_per_1m ?? 0) > 0
                const offpeak = m.offpeak_discount !== null && m.offpeak_discount !== undefined && m.offpeak_discount > 0 && m.offpeak_discount < 1
                return (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono">{m.name}</TableCell>
                    <TableCell>{m.display_name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{formatCaps(m.default_params)}</TableCell>
                    <TableCell>
                      {priced ? (
                        <span className="font-mono text-xs">
                          入 {m.input_price_per_1m} / 出 {m.output_price_per_1m}
                          {offpeak && <span className="text-amber-600"> · 谷 {Number(m.offpeak_discount) * 10}折</span>}
                        </span>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">未定价</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button size="sm" variant="outline" onClick={() => openModelPricing(m)}>价格</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteModel(m.id)}>删除</Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={provDialog} onOpenChange={setProvDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>添加上游</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>渠道</Label>
              <Select
                value={provForm.channel}
                onValueChange={(v) => {
                  const ch = channels.find((c) => c.name === v)
                  setProvForm((prev) => ({
                    ...prev,
                    channel: v,
                    // 渠道默认地址自动回填(未手填时)
                    base_url: prev.base_url === '' && ch ? ch.base_url : prev.base_url,
                  }))
                }}
              >
                <SelectTrigger><SelectValue placeholder="留空 = 手动型上游" /></SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                渠道型(如 deepseek):模型自动从上游同步,无需手填;手动型:模型来自下方列表
              </p>
            </div>
            <div className="space-y-1">
              <Label>名称(如 deepseek)</Label>
              <Input placeholder="如 deepseek" value={provForm.name} onChange={(e) => setProvForm({ ...provForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Base URL(渠道型留空自动使用渠道默认地址)</Label>
              <Input
                value={provForm.base_url}
                placeholder={provForm.channel ? channels.find((c) => c.name === provForm.channel)?.base_url ?? '' : 'https://api.example.com'}
                onChange={(e) => setProvForm({ ...provForm, base_url: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>API Key</Label>
              <Input type="password" placeholder="sk-..." value={provForm.api_key} onChange={(e) => setProvForm({ ...provForm, api_key: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>模型(逗号分隔,渠道型自动同步无需填写)</Label>
              <Input
                value={provForm.models}
                disabled={!!provForm.channel}
                placeholder={provForm.channel ? '保存后自动同步' : 'deepseek-chat, deepseek-reasoner'}
                onChange={(e) => setProvForm({ ...provForm, models: e.target.value })}
              />
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
              <Select value={modelForm.provider_id} onValueChange={(v) => {
                const p = providers.find((x) => String(x.id) === v)
                setModelForm((prev) => ({
                  ...prev,
                  provider_id: v,
                  // deepseek 渠道预填官方错峰折扣 0.5(未手填时);其它渠道留空 = 无峰谷
                  offpeak_discount: prev.offpeak_discount === '' && p?.channel === 'deepseek' ? '0.5' : prev.offpeak_discount,
                }))
              }}>
                <SelectTrigger><SelectValue placeholder="选择上游" /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="model-price-in">输入价格(元/百万 token)</Label>
                <Input
                  id="model-price-in"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 未定价"
                  value={modelForm.input_price_per_1m}
                  onChange={(e) => setModelForm({ ...modelForm, input_price_per_1m: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="model-price-out">输出价格(元/百万 token)</Label>
                <Input
                  id="model-price-out"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 未定价"
                  value={modelForm.output_price_per_1m}
                  onChange={(e) => setModelForm({ ...modelForm, output_price_per_1m: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-offpeak">低谷折扣率(0-1,留空 = 无峰谷价)</Label>
              <Input
                id="model-offpeak"
                type="number"
                min={0}
                max={1}
                step="0.05"
                placeholder="DeepSeek 官方错峰五折 = 0.5"
                value={modelForm.offpeak_discount}
                onChange={(e) => setModelForm({ ...modelForm, offpeak_discount: e.target.value })}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              配置价格后,用量页按 输入token×输入价 + 输出token×输出价 折算费用;未定价模型费用按 0 计。
              低谷折扣(DeepSeek 错峰):每日 16:30-00:30(北京时间,UTC 08:30-16:30)内费用 × 折扣率,其余时段按标准价。
            </p>
            <Button className="w-full" onClick={createModel}>新增</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 模型价格编辑(0022) */}
      <Dialog open={!!editModel} onOpenChange={(open) => { if (!open) setEditModel(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>模型价格 · {editModel?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-price-in">输入价格(元/百万 token)</Label>
                <Input
                  id="edit-price-in"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 保持现值"
                  value={editPriceForm.input}
                  onChange={(e) => setEditPriceForm({ ...editPriceForm, input: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-price-out">输出价格(元/百万 token)</Label>
                <Input
                  id="edit-price-out"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 保持现值"
                  value={editPriceForm.output}
                  onChange={(e) => setEditPriceForm({ ...editPriceForm, output: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-offpeak">低谷折扣率(0-1,留空 = 保持现值;1 = 取消峰谷)</Label>
              <Input
                id="edit-offpeak"
                type="number"
                min={0}
                max={1}
                step="0.05"
                placeholder="DeepSeek 官方错峰五折 = 0.5"
                value={editPriceForm.offpeak}
                onChange={(e) => setEditPriceForm({ ...editPriceForm, offpeak: e.target.value })}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              修改价格/折扣只影响之后产生的用量费用(历史费用按记录时定价留存)。
              低谷时段 = 每日 16:30-00:30(北京时间,UTC 08:30-16:30),DeepSeek 官方优惠五折。
            </p>
            <Button className="w-full" onClick={saveModelPricing}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
