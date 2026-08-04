import { useEffect, useState } from 'react'
import Login from './pages/Login'
import Main from './pages/Main'
import Settings from './pages/Settings'
import { useAuthStore } from './stores/auth'
import { useChatStore } from './stores/chat'
import { useConnectionStore } from './stores/connection'
import { Toaster } from './components/ui/sonner'

export default function App() {
  const authStatus = useAuthStore((s) => s.status)
  const [view, setView] = useState<'main' | 'settings'>('main')

  useEffect(() => {
    const offAgent = window.picoaide.onAgentEvent((ev) => useChatStore.getState().onAgentEvent(ev))
    // 订阅就绪后再通知主进程放行缓冲的 confirm_required(防审批弹窗丢失)
    void window.picoaide.ready()
    const offConn = window.picoaide.onConnectionStatus((status) => {
      if (status === 'trusting_cert') return
      useConnectionStore.getState().setStatus(status)
      if (status === 'auth_expired') useAuthStore.getState().handleAuthExpired()
    })
    const offLoggedIn = window.picoaide.onLoggedIn((session) => {
      useAuthStore.getState().applySession(session)
    })
    // 自动标题实时刷新(主进程 chat:title 推送,不等下次 loadConversations)
    const offTitle = window.picoaide.onChatTitle(({ conversationId, title }) => {
      useChatStore.getState().onChatTitle(conversationId, title)
    })
    void useAuthStore.getState().init()
    return () => {
      offAgent()
      offConn()
      offLoggedIn()
      offTitle()
    }
  }, [])

  useEffect(() => {
    // 深色模式跟随系统(HIG):初始读取 + 订阅 nativeTheme 变化
    const applyTheme = (t: 'dark' | 'light'): void => {
      document.documentElement.classList.toggle('dark', t === 'dark')
    }
    void window.picoaide.getTheme().then(applyTheme)
    const offTheme = window.picoaide.onThemeChanged(applyTheme)
    // 启动恢复强调色(settings 表持久化)
    void window.picoaide.accent().then((c) => {
      if (c) {
        const root = document.documentElement
        root.style.setProperty('--primary', c)
        root.style.setProperty('--primary-foreground', '210 40% 98%')
        root.style.setProperty('--ring', c)
      }
    })
    // macOS 菜单命令:Cmd+, 设置 / Cmd+N 新建会话
    const offMenu = window.picoaide.onMenuCommand((cmd) => {
      if (cmd === 'settings') setView('settings')
      else if (cmd === 'new-chat') void useChatStore.getState().newConversation()
    })
    return () => {
      offTheme()
      offMenu()
    }
  }, [])

  if (authStatus === 'unknown') {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">正在连接…</div>
  }
  if (authStatus !== 'loggedIn') return <Login />
  return (
    <>
      {view === 'settings' ? (
        <Settings onBack={() => setView('main')} />
      ) : (
        <Main onOpenSettings={() => setView('settings')} />
      )}
      <Toaster />
    </>
  )
}

