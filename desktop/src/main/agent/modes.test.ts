import { describe, expect, it } from 'vitest'
import { buildRunConfig, readOnlyTools } from './modes'

const fullTools = {
  file_read: 1,
  file_list: 2,
  file_search: 3,
  file_write: 4,
  file_edit: 5,
  file_delete: 6,
  command_exec: 7,
  browser_navigate: 8,
  browser_get_content: 9,
  web_search: 10,
  kb_upload: 11,
} as unknown as Record<string, unknown>

describe('modes', () => {
  it('readOnlyTools keeps read-only tools and drops writers', () => {
    expect(Object.keys(readOnlyTools(fullTools)).sort()).toEqual(
      ['browser_get_content', 'file_list', 'file_read', 'file_search', 'web_search'].sort(),
    )
  })

  it('plan uses read-only tools with a step budget (multi-step analysis)', () => {
    const cfg = buildRunConfig('plan', fullTools, 20)
    expect(Object.keys(cfg.tools).sort()).toEqual(
      ['browser_get_content', 'file_list', 'file_read', 'file_search', 'web_search'].sort(),
    )
    expect(cfg.maxSteps).toBe(8)
  })

  it('craft keeps all tools and the step budget', () => {
    const cfg = buildRunConfig('craft', fullTools, 20)
    expect(Object.keys(cfg.tools)).toHaveLength(11)
    expect(cfg.maxSteps).toBe(20)
  })
})
