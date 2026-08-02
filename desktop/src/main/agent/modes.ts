// 三模式(架构设计 §3.3.4):Ask 纯聊天不调工具;Plan 首轮无工具出计划(用户确认后第二轮带 tools 执行);Craft 带工具 + 步数预算
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
  // Plan 首轮:禁用工具、单步出计划,等用户确认后由引擎在第二轮带工具执行
  if (mode === 'ask' || mode === 'plan') return { tools: {} as T, maxSteps: 1 }
  return { tools, maxSteps }
}
