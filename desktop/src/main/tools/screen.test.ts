import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureScreen, HIGH_RISK_TOOLS, screenCaptureTool } from './screen'

const mocks = vi.hoisted(() => ({ getSources: vi.fn() }))

vi.mock('electron', () => ({ desktopCapturer: { getSources: mocks.getSources }, clipboard: undefined, app: undefined }))

function fakeThumbnail(width: number, height: number, bytes: string) {
  return {
    toPNG: () => Buffer.from(bytes),
    getSize: () => ({ width, height }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('captureScreen', () => {
  it('captures the primary screen as base64 PNG with dimensions', async () => {
    mocks.getSources.mockResolvedValue([{ id: 'screen:0', thumbnail: fakeThumbnail(1920, 1080, 'png-bytes') }])

    const shot = await captureScreen()

    expect(shot).toEqual({ pngBase64: Buffer.from('png-bytes').toString('base64'), width: 1920, height: 1080 })
    expect(mocks.getSources).toHaveBeenCalledWith({ types: ['screen'] })
  })

  it('throws when no screen source is available', async () => {
    mocks.getSources.mockResolvedValue([])

    await expect(captureScreen()).rejects.toThrow(/未找到屏幕/)
  })
})

describe('screenCaptureTool registration', () => {
  it('marks screen_capture as high risk via HIGH_RISK_TOOLS (not SDK needsApproval)', () => {
    expect(HIGH_RISK_TOOLS).toContain('screen_capture')
    expect(screenCaptureTool.needsApproval).toBeUndefined()
  })
})
