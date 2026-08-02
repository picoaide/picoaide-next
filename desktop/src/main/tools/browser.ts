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
]

export function createBrowserTools(opts: { port?: number } = {}): Record<string, Tool> {
  const call = (method: string) => (params: unknown) => sendCdp(method, params, opts)
  return {
    browser_tab_info: {
      description: '读取浏览器当前活动标签页的 URL 与标题(需浏览器插件已连接)',
      inputSchema: z.object({}),
      execute: async () => call('browser.tabInfo')({}),
    },
    browser_get_content: {
      description: '读取浏览器当前页可见文本(已去除 script/style;需浏览器插件已连接)',
      inputSchema: z.object({}),
      execute: async () => call('browser.getContent')({}),
    },
    browser_click: {
      description: '点击页面中匹配 CSS 选择器的元素(高危,需审批)',
      inputSchema: z.object({ selector: z.string() }),
      execute: async (input: { selector: string }) => call('browser.click')(input),
    },
    browser_type: {
      description: '向匹配 CSS 选择器的输入框输入文本(高危,需审批)',
      inputSchema: z.object({ selector: z.string(), text: z.string() }),
      execute: async (input: { selector: string; text: string }) => call('browser.type')(input),
    },
    browser_navigate: {
      description: '将浏览器当前标签页导航到指定 URL(高危,需审批)',
      inputSchema: z.object({ url: z.string() }),
      execute: async (input: { url: string }) => call('browser.navigate')(input),
    },
    browser_scroll: {
      description: '滚动当前页面(direction: up/down)(高危,需审批)',
      inputSchema: z.object({ direction: z.enum(['up', 'down']) }),
      execute: async (input: { direction: 'up' | 'down' }) => call('browser.scroll')(input),
    },
    browser_execute_js: {
      description: '在当前页面执行任意 JavaScript 代码(最高风险,需审批)',
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: { code: string }) => call('browser.executeScript')(input),
    },
  }
}
