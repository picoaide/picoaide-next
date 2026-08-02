// 三模式(架构设计 §3.3.4):Ask 纯聊天不调工具;Plan/Craft 带工具 + 步数预算
export type Mode = 'ask' | 'plan' | 'craft'

export interface RunConfig<T extends Record<string, unknown> = Record<string, unknown>> {
  tools: T
  maxSteps: number
}

export function buildRunConfig<T extends Record<string, unknown>>(
  mode: Mode,
  tools: T,
  maxSteps: number,
): RunConfig<T> {
  if (mode === 'ask') return { tools: {} as T, maxSteps: 1 }
  return { tools, maxSteps }
}
