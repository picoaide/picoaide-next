import type { Tool } from 'ai'
import { z } from 'zod'

export const HIGH_RISK_TOOLS: string[] = ['screen_capture']

// Electron 惰性动态 import(仅 main 进程可用;vitest 中用 vi.mock('electron') 拦截)
export async function loadElectronModule(): Promise<Record<string, unknown>> {
  const mod = (await import('electron')) as Record<string, unknown> & { default?: Record<string, unknown> }
  const hasMainApis = mod && (mod.desktopCapturer || mod.clipboard || mod.app)
  return hasMainApis ? mod : (mod.default ?? mod)
}

export async function captureScreen(): Promise<{ pngBase64: string; width: number; height: number }> {
  const electron = await loadElectronModule()
  const desktopCapturer = electron.desktopCapturer as {
    getSources(options: { types: string[] }): Promise<Array<{ thumbnail: { toPNG(): Buffer; getSize(): { width: number; height: number } } }>>
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'] })
  if (sources.length === 0) throw new Error('未找到屏幕')
  const { thumbnail } = sources[0]
  return { pngBase64: thumbnail.toPNG().toString('base64'), ...thumbnail.getSize() }
}

// 截屏含密码/OTP 等敏感信息 → 高危工具(引擎层按 HIGH_RISK_TOOLS 审批门控;
// 不能用 SDK 保留名 needsApproval,否则 SDK 拦截执行、引擎门控永不触发)
export const screenCaptureTool: Tool = {
  description: '截取整个屏幕,返回 PNG base64(含敏感信息,需审批)',
  inputSchema: z.object({}),
  execute: async () => captureScreen(),
}
