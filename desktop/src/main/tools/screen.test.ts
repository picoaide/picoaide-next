import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureScreen, HIGH_RISK_TOOLS, screenCaptureTool } from './screen'

const mocks = vi.hoisted(() => ({ getSources: vi.fn() }))

vi.mock('electron', () => ({ desktopCapturer: { getSources: mocks.getSources }, clipboard: undefined, app: undefined }))

function fakeThumbnail(width: number, height: number, bytes: string) {
  return {
    toPNG: () => Buffer.from(bytes),
    getSize: () => ({ width, height }),
    resize: (opts: { width: number; height: number }) => fakeThumbnail(opts.width, opts.height, 'resized-' + bytes),
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

  it('downscales an oversized (4K) capture to 1080p bounds', async () => {
    mocks.getSources.mockResolvedValue([{ id: 'screen:0', thumbnail: fakeThumbnail(3840, 2160, 'png-bytes') }])

    const shot = await captureScreen()

    expect(shot.width).toBeLessThanOrEqual(1920)
    expect(shot.height).toBeLessThanOrEqual(1080)
    // 等比缩小:3840:2160 → 1920:1080,且走 resize 分支产出缩略图
    expect(shot).toMatchObject({ width: 1920, height: 1080 })
    expect(Buffer.from(shot.pngBase64, 'base64').toString()).toBe('resized-png-bytes')
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
