import { useCallback, useEffect, useState } from 'react'
import { ArrowDownToLine, LogOut, RefreshCw, Trash2 } from 'lucide-react'
import { Input } from '../components/ui/input'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Switch } from '../components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { useAuthStore } from '../stores/auth'
import { pluginApi } from '../plugin-api'
import { errCode } from '../api/picoaide'
import type { McpListResult, McpRiskInfo, SettingsInfo, SkillRiskInfo, SkillsListResult } from '../../../main/plugin_ipc'

type RiskState = { kind: 'skill'; data: SkillRiskInfo } | { kind: 'mcp'; data: McpRiskInfo } | null

export default function Settings() {
  const logout = useAuthStore((s) => s.logout)
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [skills, setSkills] = useState<SkillsListResult>({ suggestions: [], installed: {} })
  const [mcp, setMcp] = useState<McpListResult>({ suggestions: [], installed: [] })
  const [risk, setRisk] = useState<RiskState>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [allowedDirs, setAllowedDirs] = useState<string[]>([])
  const [newDir, setNewDir] = useState('')

  const load = useCallback(async () => {
    const api = pluginApi()
    try {
      const [i, s, m, dirs] = await Promise.all([
        api.settingsInfo(), api.pluginSkillsList(), api.pluginMcpList(), api.allowedDirs(),
      ])
      setInfo(i)
      setSkills(s)
      setMcp(m)
      setAllowedDirs(dirs)
      setError('')
    } catch (e) {
      setError(errCode(e) === 'NETWORK' ? '无法连接服务器' : '加载失败,请重试')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError('')
    try {
      await fn()
      await load()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy('')
    }
  }

  const installSkill = (name: string) =>
    run('skill', async () => {
      const r = await pluginApi().pluginSkillsInstall({ name })
      if ('risk' in r) setRisk({ kind: 'skill', data: r.risk })
    })

  const confirmSkill = () =>
    risk && risk.kind === 'skill'
      ? run('skill', async () => {
          await pluginApi().pluginSkillsInstall({ name: risk.data.name, confirmed: true })
          setRisk(null)
        })
      : Promise.resolve()

  const installMcp = (id: number) =>
    run('mcp', async () => {
      const r = await pluginApi().pluginMcpInstall({ id })
      if ('risk' in r) setRisk({ kind: 'mcp', data: r.risk })
    })

  const confirmMcp = () =>
    risk && risk.kind === 'mcp'
      ? run('mcp', async () => {
          await pluginApi().pluginMcpInstall({ id: risk.data.id, confirmed: true })
          setRisk(null)
        })
      : Promise.resolve()

  const refreshConfig = () =>
    run('refresh', async () => {
      const cfg = await pluginApi().refreshBootstrap()
      useAuthStore.setState({ bootstrap: cfg })
    })

  async function addDir() {
    const dir = newDir.trim()
    if (!dir) return
    try {
      const next = await pluginApi().allowedDirs([...allowedDirs, dir])
      setAllowedDirs(next)
      setNewDir('')
    } catch (e) {
      setError(errCode(e) === 'VALIDATION' ? '目录不合法' : '保存失败')
    }
  }

  async function removeDir(dir: string) {
    try {
      const next = await pluginApi().allowedDirs(allowedDirs.filter((d) => d !== dir))
      setAllowedDirs(next)
    } catch {
      setError('保存失败')
    }
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">设置</h1>
        <Button variant="outline" size="sm" onClick={refreshConfig} disabled={busy !== ''}>
          <RefreshCw className="h-4 w-4" /> 刷新配置
        </Button>
      </div>

      {error && <div className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      {/* 账户信息(只读展示) */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>账户</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">服务器</span>
            <span className="max-w-[70%] truncate">{info?.serverURL ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">用户名</span>
            <span>{info?.username ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">当前模型</span>
            <span>{info?.model || '—'}</span>
          </div>
          <div className="pt-2">
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" /> 登出
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 技能建议安装(建议清单来自服务端 bootstrap) */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>技能</CardTitle>
          <CardDescription>服务端建议清单,员工自行安装/卸载</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {skills.suggestions.length === 0 && <p className="text-sm text-muted-foreground">暂无可用技能</p>}
          {skills.suggestions.map((s) => {
            const installed = skills.installed[s.name]
            return (
              <div key={s.name} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{s.name}</span>
                    <Badge variant="outline">{s.version}</Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{s.description}</p>
                </div>
                {installed ? (
                  <Badge variant="success">已安装 {installed.version}</Badge>
                ) : (
                  <Button size="sm" onClick={() => void installSkill(s.name)} disabled={busy !== ''}>
                    <ArrowDownToLine className="h-4 w-4" /> 安装
                  </Button>
                )}
              </div>
            )
          })}
          {Object.entries(skills.installed).map(([name, rec]) => (
            <div key={name} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-sm font-medium">{name}</span>
                <span className="ml-2 text-xs text-muted-foreground">v{rec.version}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void run('skill', () => pluginApi().pluginSkillsRemove({ name }))} disabled={busy !== ''}>
                <Trash2 className="h-4 w-4" /> 卸载
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* MCP 插件建议安装 */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>MCP 插件</CardTitle>
          <CardDescription>第三方插件安装前会展示风险信息,员工知情后决定</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {mcp.suggestions.length === 0 && <p className="text-sm text-muted-foreground">暂无可用插件</p>}
          {mcp.suggestions.map((p) => {
            const installed = mcp.installed.find((r) => r.id === p.id)
            return (
              <div key={p.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    {p.recommended && <Badge>推荐</Badge>}
                    {installed && <Badge variant="success">已安装</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{p.description}</p>
                </div>
                {!installed && (
                  <Button size="sm" onClick={() => void installMcp(p.id)} disabled={busy !== ''}>
                    <ArrowDownToLine className="h-4 w-4" /> 安装
                  </Button>
                )}
              </div>
            )
          })}
          {mcp.installed.length > 0 && (
            <div className="border-t pt-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">已安装</p>
              {mcp.installed.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 py-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-sm font-medium">{r.name}</span>
                    <Badge variant={r.enabled ? 'success' : 'outline'}>{r.enabled ? '启用' : '停用'}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={(v) => void run('mcp', () => pluginApi().pluginMcpToggle({ id: r.id, enabled: v }))}
                      disabled={busy !== ''}
                    />
                    <Button variant="ghost" size="sm" onClick={() => void run('mcp', () => pluginApi().pluginMcpRemove({ id: r.id }))} disabled={busy !== ''}>
                      <Trash2 className="h-4 w-4" /> 卸载
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 可访问目录:唯一本地配置项(本地安全边界,管理员无法替员工决定本机路径) */}
      <Card>
        <CardHeader>
          <CardTitle>可访问目录</CardTitle>
          <CardDescription>
            本地安全边界:Agent 仅可访问以下目录中的文件;工具访问目录外路径时会弹窗引导一键授权
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-1">
            {allowedDirs.map((d) => (
              <li key={d} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span className="font-mono truncate">{d}</span>
                <Button variant="ghost" size="sm" onClick={() => removeDir(d)} disabled={busy !== ''}>
                  <Trash2 className="h-4 w-4" /> 移除
                </Button>
              </li>
            ))}
            {allowedDirs.length === 0 && (
              <li className="text-sm text-muted-foreground">仅默认工作区目录可用</li>
            )}
          </ul>
          <div className="flex gap-2">
            <Input
              placeholder="/home/you/Documents(绝对路径)"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
            />
            <Button onClick={addDir} disabled={busy !== '' || !newDir.trim()}>添加</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            越界引导:Agent 访问未授权路径时弹出确认框,同意后自动加入此列表并重试
          </p>
        </CardContent>
      </Card>

      {/* 第三方安装风险弹窗(硬防线:安装前展示插件名/来源/命令) */}
      <Dialog open={risk !== null} onOpenChange={(open) => !open && setRisk(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{risk?.kind === 'skill' ? '技能安装确认' : '插件安装风险确认'}</DialogTitle>
            <DialogDescription>
              {risk?.kind === 'skill'
                ? '第三方技能来自商城分发,首次安装前请确认其来源与内容。'
                : '第三方插件可执行本地命令或访问网络,安装前请确认其来源与权限范围。'}
            </DialogDescription>
          </DialogHeader>
          {risk && (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">名称</span>
                <span className="font-medium">{risk.data.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">来源</span>
                <span className="max-w-[60%] truncate">{risk.data.source}</span>
              </div>
              {risk.kind === 'skill' ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">作者</span>
                    <span>{risk.data.author || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">版本</span>
                    <span>{risk.data.version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">入口</span>
                    <span>{risk.data.entrypoint}</span>
                  </div>
                  {risk.data.dependencies.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">依赖</span>
                      <span>{risk.data.dependencies.join(', ')}</span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">传输</span>
                    <span>{risk.data.transport === 'stdio' ? '本地进程 (stdio)' : `HTTP: ${risk.data.url || '—'}`}</span>
                  </div>
                  {risk.data.command && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">命令</span>
                      <span className="max-w-[60%] truncate">
                        {risk.data.command} {risk.data.args.join(' ')}
                      </span>
                    </div>
                  )}
                </>
              )}
              {risk.data.description && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">说明</span>
                  <span className="max-w-[60%] text-right">{risk.data.description}</span>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRisk(null)}>
              取消
            </Button>
            <Button onClick={() => void (risk?.kind === 'skill' ? confirmSkill() : confirmMcp())} disabled={busy !== ''}>
              确认安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
