import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clipboardReadTool, clipboardWriteTool, HIGH_RISK_TOOLS } from './clipboard'

const mocks = vi.hoisted(() => ({
  readText: vi.fn(),
  availableFormats: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('electron', () => ({
  clipboard: { readText: mocks.readText, availableFormats: mocks.availableFormats, writeText: mocks.writeText },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('clipboardReadTool', () => {
  it('reads text when the clipboard has text content', async () => {
    mocks.availableFormats.mockReturnValue(['text/plain'])
    mocks.readText.mockReturnValue('hello')
    expect(await clipboardReadTool.execute!({}, {} as never)).toEqual({ text: 'hello' })
  })

  it('reports a clear error when the clipboard has no text content', async () => {
    mocks.availableFormats.mockReturnValue(['image/png'])
    await expect(clipboardReadTool.execute!({}, {} as never)).rejects.toThrow('剪贴板中没有文本内容')
    expect(mocks.readText).not.toHaveBeenCalled()
  })

  it('surfaces read failures instead of silently returning empty text', async () => {
    mocks.availableFormats.mockReturnValue(['text/plain'])
    mocks.readText.mockImplementation(() => {
      throw new Error('x11 clipboard error')
    })
    await expect(clipboardReadTool.execute!({}, {} as never)).rejects.toThrow(/剪贴板读取失败/)
  })
})

describe('clipboard tool registration', () => {
  it('marks clipboard_read as high risk via HIGH_RISK_TOOLS (not SDK needsApproval)', () => {
    expect(clipboardReadTool.needsApproval).toBeUndefined()
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
