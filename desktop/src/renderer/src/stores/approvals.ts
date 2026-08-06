import { create } from 'zustand'
import { picoaide } from '../api/picoaide'

export interface ApprovalRequest {
  request_id: string
  tool_call_id?: string
  op: string
  target: string
  reason: string
  expiresAt: number
}

export const APPROVAL_TIMEOUT_MS = 60_000

interface ApprovalsState {
  queue: ApprovalRequest[]
  push: (data: { request_id: string; tool_call_id?: string; op: string; target: string; reason: string }) => void
  // 回执后由引擎 settle,超时/取消的迟到回执是引擎侧 no-op
  resolve: (requestId: string, ok: boolean) => void
  clear: () => void
}

export const useApprovalsStore = create<ApprovalsState>((set) => ({
  queue: [],
  // 过期项不消费(引擎 60s 超时已拒绝,UI 残留卡到 done):push 时过滤,
  // 新审批不与过期残留同屏;超时/取消的迟到回执是引擎侧 no-op
  push: (data) =>
    set((s) => ({
      queue: [
        ...s.queue.filter((q) => q.expiresAt > Date.now()),
        { ...data, expiresAt: Date.now() + APPROVAL_TIMEOUT_MS },
      ],
    })),
  resolve: (requestId, ok) => {
    void picoaide().confirm(requestId, ok)
    set((s) => ({ queue: s.queue.filter((q) => q.request_id !== requestId) }))
  },
  clear: () => set({ queue: [] }),
}))
