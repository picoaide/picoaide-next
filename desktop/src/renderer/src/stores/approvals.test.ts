import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useApprovalsStore } from './approvals'

describe('approvals store', () => {
  beforeEach(() => {
    useApprovalsStore.setState({ queue: [] })
  })

  it('push filters out expired approvals (stale UI cards are not re-shown)', () => {
    // B-9 回归:引擎 60s 超时已拒绝审批,UI 残留卡到 done;push 时过滤过期项,
    // 后续新审批不会与过期残留同屏
    vi.useFakeTimers()
    try {
      useApprovalsStore.getState().push({ request_id: 'r1', op: 'bash', target: 'rm -rf /', reason: '高危' })
      expect(useApprovalsStore.getState().queue).toHaveLength(1)
      vi.advanceTimersByTime(61_000)
      useApprovalsStore.getState().push({ request_id: 'r2', op: 'bash', target: 'ls', reason: '' })
      const q = useApprovalsStore.getState().queue
      expect(q.map((a) => a.request_id)).toEqual(['r2'])
      expect(q[0].expiresAt).toBeGreaterThan(Date.now())
    } finally {
      vi.useRealTimers()
    }
  })
})
