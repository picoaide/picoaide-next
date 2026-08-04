// 三模式(架构设计 §3.3.4):计划(只读)首轮用只读工具调研出计划,用户确认后第二轮带全量工具执行;执行(craft)带工具 + 步数预算。
// 对齐 opencode 的 Build/Plan 区分:模式差异 = 工具集 + 提示词,而不是轮次流程。
export type Mode = 'plan' | 'craft'

export interface RunConfig<T extends Record<string, unknown> = Record<string, unknown>> {
  tools: T
  maxSteps: number
}

// 只读工具白名单(计划模式):可读文件/搜索/浏览/查知识库,禁止一切写入、执行与浏览器操作。
// 全精确名匹配:前缀匹配会被 MCP 插件的同名工具误命中(如插件工具叫 web_xxx 在 plan 模式开放)。
// 新增工具默认在计划模式下不可用(安全默认);screen_capture/clipboard_read 是"读"但属高危,
// 不进只读名单 —— 它们在计划模式也要走审批(engine.plan 传 highRiskTools)。
const READ_ONLY_NAMES = new Set([
  'file_read',
  'file_list',
  'file_search',
  'web_fetch',
  'web_search',
  'browser_tab_info',
  'browser_get_content',
  'kb_search',
  'kb_read',
  'kb_list',
])

export function readOnlyTools<T extends Record<string, unknown>>(tools: T): T {
  const out: Record<string, unknown> = {}
  for (const [name, t] of Object.entries(tools)) {
    if (READ_ONLY_NAMES.has(name)) out[name] = t
  }
  return out as T
}

export const PLAN_MAX_STEPS = 8

export function buildRunConfig<T extends Record<string, unknown>>(
  mode: Mode,
  tools: T,
  maxSteps: number,
): RunConfig<T> {
  // 计划(只读)模式:只读工具多步调研出计划,确认后由引擎第二轮带全量工具执行
  if (mode === 'plan') return { tools: readOnlyTools(tools), maxSteps: Math.min(maxSteps, PLAN_MAX_STEPS) }
  return { tools, maxSteps }
}
