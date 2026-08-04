// 三模式(架构设计 §3.3.4):计划(只读)首轮用只读工具调研出计划,用户确认后第二轮带全量工具执行;执行(craft)带工具 + 步数预算。
// 对齐 opencode 的 Build/Plan 区分:模式差异 = 工具集 + 提示词,而不是轮次流程。
export type Mode = 'plan' | 'craft'

export interface RunConfig<T extends Record<string, unknown> = Record<string, unknown>> {
  tools: T
  maxSteps: number
}

// 只读工具白名单(计划模式):可读文件/搜索/浏览/查知识库,禁止一切写入、执行与浏览器操作。
// 白名单按工具名前缀/精确名匹配,新增工具默认在计划模式下不可用(安全默认)。
// 注意:screen_capture/clipboard_read 虽是"读",但属高危敏感操作(架构 §5 审批门控),
// 不进只读名单 —— 它们在计划模式也要走审批(engine.plan 传 highRiskTools)。
const READ_ONLY_MATCHERS: Array<{ prefix?: string; exact?: string }> = [
  { exact: 'file_read' },
  { exact: 'file_list' },
  { exact: 'file_search' },
  { prefix: 'web_' },
  { exact: 'browser_tab_info' },
  { exact: 'browser_get_content' },
  { prefix: 'kb_' },
]
// kb_upload 走 kb_ 前缀但实际是数据外发,计划模式必须排除
const READ_ONLY_EXCLUDE = new Set(['kb_upload'])

export function readOnlyTools<T extends Record<string, unknown>>(tools: T): T {
  const out: Record<string, unknown> = {}
  for (const [name, t] of Object.entries(tools)) {
    if (READ_ONLY_EXCLUDE.has(name)) continue
    const hit = READ_ONLY_MATCHERS.some((m) => (m.exact !== undefined ? name === m.exact : name.startsWith(m.prefix ?? '')))
    if (hit) out[name] = t
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
