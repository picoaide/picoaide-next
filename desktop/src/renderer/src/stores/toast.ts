import { create } from 'zustand'

const TOAST_MS = 2500

interface ToastState {
  message: string | null
  show: (msg: string) => void
  clear: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null

// 极简全局 toast:单条消息,2.5s 自动消失;新消息重置计时(ponytail: 排队/多条的语义以后有需要再加)
export const useToastStore = create<ToastState>((set) => ({
  message: null,
  show: (msg) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => set({ message: null }), TOAST_MS)
    set({ message: msg })
  },
  clear: () => {
    if (timer) clearTimeout(timer)
    set({ message: null })
  },
}))
