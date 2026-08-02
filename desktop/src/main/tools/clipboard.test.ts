import { describe, expect, it } from 'vitest'
import { clipboardReadTool, clipboardWriteTool, HIGH_RISK_TOOLS } from './clipboard'

describe('clipboard tool registration', () => {
  it('marks clipboard_read as high risk (needsApproval)', () => {
    expect(clipboardReadTool.needsApproval).toBe(true)
    expect(HIGH_RISK_TOOLS).toContain('clipboard_read')
  })

  it('does not mark clipboard_write as high risk', () => {
    expect(clipboardWriteTool.needsApproval).toBeUndefined()
    expect(HIGH_RISK_TOOLS).not.toContain('clipboard_write')
  })

  it('exposes expected input schemas', () => {
    expect(clipboardReadTool.inputSchema).toBeDefined()
    expect(clipboardWriteTool.inputSchema).toBeDefined()
  })
})
