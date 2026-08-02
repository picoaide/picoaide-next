import type { Tool } from 'ai'
import { z } from 'zod'
import { loadElectronModule } from './screen'

export const HIGH_RISK_TOOLS: string[] = ['clipboard_read']

// 读取剪贴板可能暴露密码/验证码等 → 高危工具(引擎层按 HIGH_RISK_TOOLS 审批门控)
export const clipboardReadTool: Tool = {
  description: '读取系统剪贴板文本(含敏感信息,需审批)',
  inputSchema: z.object({}),
  execute: async () => {
    const electron = await loadElectronModule()
    const clipboard = electron.clipboard as { readText(): string }
    return { text: clipboard.readText() }
  },
}

export const clipboardWriteTool: Tool = {
  description: '将文本写入系统剪贴板',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    const electron = await loadElectronModule()
    const clipboard = electron.clipboard as { writeText(text: string): void }
    clipboard.writeText(text)
    return { ok: true }
  },
}
