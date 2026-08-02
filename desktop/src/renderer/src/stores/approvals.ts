import { create } from 'zustand'
import { picoaide } from '../api/picoaide'

export interface ApprovalRequest {
  request_id: string
  op: string
  target: string
  reason: string
  expiresAt: number
}

export const APPROVAL_TIMEOUT_MS = 60_000

interface ApprovalsState {
  queue: ApprovalRequest[]
  push: (data: { request_id: string; op: string; target: string; reason: string }) => void
  // 回执后由引擎 settle,超时/取消的迟到回执是引擎侧 no-op
  resolve: (requestId: string, ok: boolean) => void
  clear: () => void
}

export const useApprovalsStore = create<ApprovalsState>((set) => ({
  queue: [],
  push: (data) =>
    set((s) => ({ queue: [...s.queue, { ...data, expiresAt: Date.now() + APPROVAL_TIMEOUT_MS }] })),
  resolve: (requestId, ok) => {
    void picoaide().confirm(requestId, ok)
    set((s) => ({ queue: s.queue.filter((q) => q.request_id !== requestId) }))
  },
  clear: () => set({ queue: [] }),
}))
