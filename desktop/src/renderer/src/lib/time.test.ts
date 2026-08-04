import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from './time'

const now = new Date('2026-08-04T12:00:00').getTime()

describe('formatRelativeTime', () => {
  it('renders 刚刚 under a minute', () => {
    expect(formatRelativeTime('2026-08-04 11:59:30', now)).toBe('刚刚')
  })
  it('renders minutes and hours', () => {
    expect(formatRelativeTime('2026-08-04 11:30:00', now)).toBe('30 分钟前')
    expect(formatRelativeTime('2026-08-04 09:00:00', now)).toBe('3 小时前')
  })
  it('renders 昨天 for the previous day', () => {
    expect(formatRelativeTime('2026-08-03 06:00:00', now)).toBe('昨天')
  })
  it('renders MM-DD within the same year, full date otherwise', () => {
    expect(formatRelativeTime('2026-07-01 10:00:00', now)).toBe('07-01')
    expect(formatRelativeTime('2025-12-31 10:00:00', now)).toBe('2025-12-31')
  })
  it('returns empty for empty or invalid input', () => {
    expect(formatRelativeTime('')).toBe('')
    expect(formatRelativeTime(null)).toBe('')
    expect(formatRelativeTime('not-a-date')).toBe('')
  })
})
