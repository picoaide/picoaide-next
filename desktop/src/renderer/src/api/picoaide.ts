import type { PicoaideAPI } from '../../../preload'

// 惰性取 window.picoaide(renderer 运行期 preload 已注入;测试可 stub globalThis.window)
export function picoaide(): PicoaideAPI {
  return window.picoaide
}

// ipc invoke 的错误跨进程只保留 message,code 以 "code: message" 前缀编码(main/ipc.ts authIpcError)
export function errCode(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err.code) return err.code
  const m = err.message ?? ''
  const i = m.indexOf(': ')
  return i > 0 ? m.slice(0, i) : m
}

// 与 main/session_cache.ts validateServerURL 同语义(main 强制,这里仅用于表单即时反馈/OIDC 按钮可用性)
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function validateServerURL(raw: string): { ok: boolean; error?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: '请输入服务器地址' }
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return { ok: false, error: '地址需以 http:// 或 https:// 开头' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '地址需以 http:// 或 https:// 开头' }
  }
  if (!u.hostname) return { ok: false, error: '地址缺少主机名' }
  const isLocal = LOCAL_HOSTS.has(u.hostname.toLowerCase())
  if (!isLocal && u.protocol !== 'https:') {
    return { ok: false, error: '远程服务器必须使用 HTTPS 连接' }
  }
  return { ok: true }
}
