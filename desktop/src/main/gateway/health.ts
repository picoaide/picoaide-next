import { AuthError, fetchJSON } from './auth'
import type { Session } from './config'

export type HealthStatus = 'online' | 'offline' | 'auth_expired'

export async function ping(serverURL: string, token: string): Promise<HealthStatus> {
  try {
    await fetchJSON(serverURL, '/api/auth/me', { token })
    return 'online'
  } catch (e) {
    if (e instanceof AuthError && e.kind === 'auth_expired') return 'auth_expired'
    return 'offline'
  }
}

export function createHealthPoller(session: Session, opts: { intervalMs: number }) {
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight = false
  return {
    start(cb: (status: HealthStatus) => void): void {
      if (timer) return
      const tick = async () => {
        if (inFlight) return // 上一轮 ping 未返回:跳过,不堆叠请求、不覆盖新鲜结果
        inFlight = true
        try {
          cb(await ping(session.serverURL, session.token))
        } finally {
          inFlight = false
        }
      }
      timer = setInterval(tick, opts.intervalMs)
      void tick()
    },
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
