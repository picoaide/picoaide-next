import type { Tool } from 'ai'
import { z } from 'zod'
import { loadElectronModule } from '../util/electron'

export const HIGH_RISK_TOOLS: string[] = ['screen_capture']

// 截屏尺寸上限(1080p):4K/5K 屏整屏 PNG 可达数十 MB base64,上下文/渲染都会爆。
// 超限等比缩小,保持画面信息同时限制体积
const MAX_CAPTURE_WIDTH = 1920
const MAX_CAPTURE_HEIGHT = 1080

// Electron NativeImage 子集:resize 返回仍是 NativeImage,可连续缩放
interface ScreenThumb {
  toPNG(): Buffer
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number }): ScreenThumb
}

export async function captureScreen(): Promise<{ pngBase64: string; width: number; height: number }> {
  const electron = await loadElectronModule()
  const desktopCapturer = electron.desktopCapturer as {
    getSources(options: { types: string[] }): Promise<Array<{ thumbnail: ScreenThumb }>>
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'] })
  if (sources.length === 0) throw new Error('未找到屏幕')
  let thumbnail = sources[0].thumbnail
  const { width, height } = thumbnail.getSize()
  if (width > MAX_CAPTURE_WIDTH || height > MAX_CAPTURE_HEIGHT) {
    // 等比缩放:按较长边贴合 1080p 上限
    const scale = Math.min(MAX_CAPTURE_WIDTH / width, MAX_CAPTURE_HEIGHT / height)
    thumbnail = thumbnail.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
  }
  const size = thumbnail.getSize()
  return { pngBase64: thumbnail.toPNG().toString('base64'), ...size }
}

// 截屏含密码/OTP 等敏感信息 → 高危工具(引擎层按 HIGH_RISK_TOOLS 审批门控;
// 不能用 SDK 保留名 needsApproval,否则 SDK 拦截执行、引擎门控永不触发)
export const screenCaptureTool: Tool = {
  description: '截取整个屏幕,返回 PNG base64(含敏感信息,需审批)',
  inputSchema: z.object({}),
  execute: async () => captureScreen(),
}
