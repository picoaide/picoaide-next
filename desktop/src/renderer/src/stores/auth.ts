import { create } from 'zustand'
import { errCode, picoaide } from '../api/picoaide'
import type { Session, BootstrapConfig } from '../../../main/gateway/config'
import { useConnectionStore } from './connection'

export type AuthStatus = 'unknown' | 'loggedOut' | 'loggedIn' | 'expired'

export const LOGIN_ERRORS: Record<string, string> = {
  invalid_credentials: '用户名或密码错误',
  network: '无法连接服务器',
  server_error: '服务器错误,请稍后再试',
  auth_expired: '登录已过期,请重新登录',
  AUTH_REQUIRED: '登录已过期,请重新登录',
}

interface AuthState {
  status: AuthStatus
  session: Session | null
  bootstrap: BootstrapConfig | null
  loginError: string | null
  init: () => Promise<void>
  login: (serverURL: string, username: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
  applySession: (session: Session, bootstrap?: BootstrapConfig | null) => void
  handleAuthExpired: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  session: null,
  bootstrap: null,
  loginError: null,

  init: async () => {
    try {
      const session = await picoaide().loadSession()
      if (!session) {
        set({ status: 'loggedOut' })
        return
      }
      // main 已在 loadSession 时重拉 bootstrap 并缓存;这里再取一份给 UI(模型名等)
      const bootstrap = await picoaide().refreshBootstrap().catch(() => null)
      set({ status: 'loggedIn', session, bootstrap })
      useConnectionStore.getState().reset()
    } catch {
      set({ status: 'loggedOut' })
    }
  },

  login: async (serverURL, username, password) => {
    set({ loginError: null })
    try {
      const { session, bootstrap } = await picoaide().login(serverURL, username, password)
      set({ status: 'loggedIn', session, bootstrap })
      useConnectionStore.getState().reset()
      return true
    } catch (e) {
      set({ loginError: LOGIN_ERRORS[errCode(e)] ?? '登录失败,请稍后再试' })
      return false
    }
  },

  logout: async () => {
    try {
      await picoaide().logout()
    } finally {
      set({ status: 'loggedOut', session: null, bootstrap: null, loginError: null })
      useConnectionStore.getState().reset()
    }
  },

  applySession: (session, bootstrap) => {
    set((s) => ({ status: 'loggedIn', session, bootstrap: bootstrap ?? s.bootstrap }))
    useConnectionStore.getState().reset()
  },

  handleAuthExpired: () => {
    set({ status: 'expired', session: null, loginError: LOGIN_ERRORS.auth_expired })
  },
}))
