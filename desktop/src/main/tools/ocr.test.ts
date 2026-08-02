import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  appPath: '/nonexistent/app-root',
  recognize: vi.fn(),
}))

vi.mock('tesseract.js', () => ({ createWorker: mocks.createWorker }))
vi.mock('electron', () => ({ desktopCapturer: undefined, clipboard: undefined, app: { getAppPath: () => mocks.appPath } }))

const tmp = mkdtempSync(join(tmpdir(), 'ocr-test-'))
const tessdata = join(tmp, 'resources', 'tessdata')

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules() // 重置模块态:ocr 的 worker 单例跨测试隔离
  mkdirSync(tessdata, { recursive: true })
  mocks.appPath = tmp
  mocks.createWorker.mockResolvedValue({ recognize: mocks.recognize })
  mocks.recognize.mockResolvedValue({ data: { text: '  hello 世界 \n' } })
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('ocrImage', () => {
  it('recognizes text from a PNG using a local chi_sim+eng worker', async () => {
    const { ocrImage } = await import('./ocr')

    const text = await ocrImage(Buffer.from('png').toString('base64'))

    expect(text).toBe('hello 世界')
    expect(mocks.createWorker).toHaveBeenCalledWith(['chi_sim', 'eng'], 1, { langPath: tessdata })
    expect(mocks.recognize).toHaveBeenCalledWith(Buffer.from('png'))
  })

  it('reuses the worker across calls (lazy singleton)', async () => {
    const { ocrImage } = await import('./ocr')
    await ocrImage('cGFwcA==')
    await ocrImage('cGFwcA==')

    expect(mocks.createWorker).toHaveBeenCalledTimes(1)
  })

  it('throws a clear error when the local tessdata dir is missing', async () => {
    mocks.appPath = '/nonexistent/app-root'
    const { ocrImage } = await import('./ocr')

    await expect(ocrImage('cGFwcA==')).rejects.toThrow('OCR 语言包未安装')
    expect(mocks.createWorker).not.toHaveBeenCalled()
  })

  it('degrades with a clear error when worker creation fails', async () => {
    mocks.createWorker.mockRejectedValue(new Error('langdata fetch failed'))
    const { ocrImage } = await import('./ocr')

    await expect(ocrImage('cGFwcA==')).rejects.toThrow(/OCR 不可用/)
  })
})
