import { describe, expect, it } from 'vitest'
import { buildHandlers } from './ipc'

describe('ipc handlers', () => {
  it('picoaide:version returns the app version', () => {
    const handlers = buildHandlers()
    expect(handlers['picoaide:version']()).toBe('0.2.0')
  })
})
