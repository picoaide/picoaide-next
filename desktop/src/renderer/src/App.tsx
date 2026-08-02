import { useEffect } from 'react'
import Login from './pages/Login'
import Main from './pages/Main'
import { useAuthStore } from './stores/auth'
import { useChatStore } from './stores/chat'
import { useConnectionStore } from './stores/connection'

export default function App() {
  const authStatus = useAuthStore((s) => s.status)

  useEffect(() => {
    const offAgent = window.picoaide.onAgentEvent((ev) => useChatStore.getState().onAgentEvent(ev))
    const offConn = window.picoaide.onConnectionStatus((status) => {
      if (status === 'trusting_cert') return
      useConnectionStore.getState().setStatus(status)
      if (status === 'auth_expired') useAuthStore.getState().handleAuthExpired()
    })
    const offLoggedIn = window.picoaide.onLoggedIn((session) => {
      useAuthStore.getState().applySession(session)
    })
    void useAuthStore.getState().init()
    return () => {
      offAgent()
      offConn()
      offLoggedIn()
    }
  }, [])

  if (authStatus === 'unknown') {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">正在连接…</div>
  }
  return authStatus === 'loggedIn' ? <Main /> : <Login />
}
