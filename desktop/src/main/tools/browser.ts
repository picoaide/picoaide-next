import { z } from 'zod'
import type { Tool } from 'ai'
import { sendCdp } from '../cdp_server'

// 高危工具清单:引擎层审批门控识别(run({ tools, highRiskTools: new Set(HIGH_RISK_TOOLS) }))
// 读取类(当前页 URL/标题/文本)直接可用;操作类与任意 JS 执行需审批(架构 §3.8)
export const HIGH_RISK_TOOLS: string[] = [
  'browser_click',
  'browser_type',
  'browser_navigate',
  'browser_scroll',
  'browser_execute_js',
  'browser_fill',
  'browser_select',
  'browser_dialog',
]

// 按方法给 sendCdp 超时(默认 5s):扩展侧 waitFor 最长等 60s、dialog 等 10s,
// 默认 5s 会腰斩长等待(Agent 等元素出现时先于插件报超时)。返回 undefined 走默认。
export function cdpTimeoutFor(method: string, params: unknown): number | undefined {
  if (method === 'browser.waitFor') {
    const timeoutMs = (params as { timeoutMs?: number } | null)?.timeoutMs ?? 10000
    return Math.min(timeoutMs + 2000, 65000) // +2s 余量,上限 65s(扩展上限 60s)
  }
  if (method === 'browser.dialog') return 12000
  return undefined
}

export function createBrowserTools(opts: { port?: number } = {}): Record<string, Tool> {
  const call = (method: string, params: unknown) =>
    sendCdp(method, params, { ...opts, ...(cdpTimeoutFor(method, params) ? { timeoutMs: cdpTimeoutFor(method, params) } : {}) })
  return {
    browser_tab_info: {
      description: '读取浏览器当前活动标签页的 URL 与标题(需浏览器插件已连接)',
      inputSchema: z.object({}),
      execute: async () => call('browser.tabInfo', {}),
    },
    browser_get_content: {
      description:
        '读取浏览器当前页的结构化语义快照(标题/链接/按钮/输入框含 placeholder 与 aria-label/图片 alt/列表/表格行/正文段落);输入框可用其 placeholder 或 aria-label 配合 browser_fill/browser_select 语义定位(需浏览器插件已连接)',
      inputSchema: z.object({}),
      execute: async () => call('browser.getContent', {}),
    },
    browser_click: {
      description: '点击页面中匹配 CSS 选择器的元素(高危,需审批)',
      inputSchema: z.object({ selector: z.string() }),
      execute: async (input: { selector: string }) => call('browser.click', input),
    },
    browser_type: {
      description: '向匹配 CSS 选择器的输入框输入文本(高危,需审批)',
      inputSchema: z.object({ selector: z.string(), text: z.string() }),
      execute: async (input: { selector: string; text: string }) => call('browser.type', input),
    },
    browser_navigate: {
      description: '将浏览器当前标签页导航到指定 URL(高危,需审批)',
      inputSchema: z.object({ url: z.string() }),
      execute: async (input: { url: string }) => call('browser.navigate', input),
    },
    browser_scroll: {
      description: '滚动当前页面(direction: up/down)(高危,需审批)',
      inputSchema: z.object({ direction: z.enum(['up', 'down']) }),
      execute: async (input: { direction: 'up' | 'down' }) => call('browser.scroll', input),
    },
    browser_execute_js: {
      description: '在当前页面执行任意 JavaScript 代码(最高风险,需审批)',
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: { code: string }) => call('browser.executeScript', input),
    },
    browser_fill: {
      description:
        '向页面表单元素(输入框/文本域)填入值。selector 优先按语义定位(label 文本/placeholder/aria-label,忽略大小写),找不到才当作 CSS 选择器;兼容 React(触发 input/change 事件;高危,需审批)',
      inputSchema: z.object({ selector: z.string(), value: z.string() }),
      execute: async (input: { selector: string; value: string }) => call('browser.fill', input),
    },
    browser_select: {
      description:
        '在页面下拉框(select)中选择与 value 或可见文本匹配的选项。selector 语义定位同 browser_fill(高危,需审批)',
      inputSchema: z.object({ selector: z.string(), value: z.string() }),
      execute: async (input: { selector: string; value: string }) => call('browser.select', input),
    },
    browser_wait_for: {
      description:
        '等待页面出现匹配的元素(selector 语义定位同 browser_fill;timeoutMs 默认 10000,只读不审批)',
      inputSchema: z.object({ selector: z.string(), timeoutMs: z.number().optional() }),
      execute: async (input: { selector: string; timeoutMs?: number }) => call('browser.waitFor', input),
    },
    browser_dialog: {
      description: '处理浏览器 JS 弹窗(confirm/alert/prompt):action=accept 确认,action=dismiss 取消;最多等 10s(高危,需审批)',
      inputSchema: z.object({ action: z.enum(['accept', 'dismiss']) }),
      execute: async (input: { action: 'accept' | 'dismiss' }) => call('browser.dialog', input),
    },
  }
}
