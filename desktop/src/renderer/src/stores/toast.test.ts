import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useToastStore } from './toast'

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useToastStore.setState({ message: null })
  })
  afterEach(() => vi.useRealTimers())

  it('show sets the message and auto-clears after 2.5s', () => {
    useToastStore.getState().show('已复制到剪贴板')
    expect(useToastStore.getState().message).toBe('已复制到剪贴板')
    vi.advanceTimersByTime(2600)
    expect(useToastStore.getState().message).toBeNull()
  })

  it('showing again resets the timer (single message, latest wins)', () => {
    useToastStore.getState().show('第一条')
    vi.advanceTimersByTime(1000)
    useToastStore.getState().show('第二条')
    vi.advanceTimersByTime(1500)
    expect(useToastStore.getState().message).toBe('第二条')
    vi.advanceTimersByTime(1100)
    expect(useToastStore.getState().message).toBeNull()
  })

  it('clear hides immediately', () => {
    useToastStore.getState().show('x')
    useToastStore.getState().clear()
    expect(useToastStore.getState().message).toBeNull()
  })
})
