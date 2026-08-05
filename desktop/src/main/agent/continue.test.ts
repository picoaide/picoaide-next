import { describe, expect, it } from 'vitest'
import type { DBMessage } from './engine'
import { lastUserMessageIndex } from './continue'

describe('lastUserMessageIndex', () => {
  it('returns the index of the last user row', () => {
    const rows: DBMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]
    expect(lastUserMessageIndex(rows)).toBe(2)
  })

  it('returns -1 when there are no user rows', () => {
    expect(lastUserMessageIndex([])).toBe(-1)
    expect(lastUserMessageIndex([{ role: 'assistant', content: 'b' }])).toBe(-1)
  })
})
