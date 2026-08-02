import { useState } from 'react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useAuthStore } from '../stores/auth'
import { picoaide, validateServerURL } from '../api/picoaide'

export default function Login() {
  const [serverURL, setServerURL] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const login = useAuthStore((s) => s.login)
  const loginError = useAuthStore((s) => s.loginError)

  const canSubmit = () => {
    const v = validateServerURL(serverURL)
    if (!v.ok) {
      setUrlError(v.error ?? '服务器地址无效')
      return null
    }
    setUrlError(null)
    return serverURL
  }

  const submit = async () => {
    const url = canSubmit()
    if (!url || !username || !password) return
    setBusy(true)
    try {
      await login(url, username, password)
    } finally {
      setBusy(false)
    }
  }

  const oidc = async () => {
    const url = canSubmit()
    if (!url) return
    setBusy(true)
    try {
      await picoaide().oidcLogin(url)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-muted/40">
      <Card className="w-[380px]">
        <CardHeader>
          <CardTitle>登录 PicoAide</CardTitle>
          <CardDescription>输入企业服务器地址与账号,零配置即用</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loginError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {loginError}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="server">服务器地址</Label>
            <Input
              id="server"
              placeholder="https://picoaide.example.com"
              value={serverURL}
              onChange={(e) => {
                setServerURL(e.target.value)
                setUrlError(null)
              }}
            />
            {urlError && <p className="text-xs text-destructive">{urlError}</p>}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">用户名</Label>
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
            />
          </div>
          <div className="flex flex-col gap-2 pt-2">
            <Button disabled={busy || !serverURL.trim() || !username || !password} onClick={() => void submit()}>
              {busy ? '登录中…' : '登录'}
            </Button>
            <Button variant="outline" disabled={busy || !serverURL.trim()} onClick={() => void oidc()}>
              企业账号登录 (OIDC)
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
