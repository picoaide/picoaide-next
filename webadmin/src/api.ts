export class ApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

let csrfToken = ''

export function setCsrf(token: string) {
  csrfToken = token
}

export async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  }
  if (csrfToken && (init.method === undefined || !['GET', 'HEAD'].includes(init.method))) {
    headers['X-CSRF-Token'] = csrfToken
  }
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let code = 'INTERNAL'
    let message = res.statusText
    try {
      const body = await res.json()
      code = body?.error?.code ?? code
      message = body?.error?.message ?? message
    } catch {
      /* keep defaults */
    }
    throw new ApiError(res.status, code, message)
  }
  return res.json() as Promise<T>
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    let msg = '登录失败'
    try {
      msg = (await res.json())?.error?.message ?? msg
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  const body = await res.json()
  setCsrf(body.csrf_token)
}

export async function logout(): Promise<void> {
  await request('/api/admin/logout', { method: 'POST' })
}

export async function me(): Promise<any> {
  return request('/api/admin/me')
}
