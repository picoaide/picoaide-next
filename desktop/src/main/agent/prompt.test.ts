import { describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT, PLAN_SYSTEM_NOTICE, buildSystemPrompt } from './prompt'

describe('default system prompt', () => {
  const requiredPhrases = [
    'PicoAide', // 1 身份职责
    '输出到对话', // 2 系统规则
    '先读文件再修改', // 3 执行任务
    '先想后写', // 4 工程准则
    '审批弹窗', // 5 谨慎执行
    'browser_', // 6 工具纪律(浏览器工具)
    '允许目录', // 6 工具纪律(路径边界)
    'AGENTS.md', // 6 工具纪律(项目指令)
    '计划', // 7 规划执行
    '路径:行号', // 8 语气格式(文件引用)
    '直入主题', // 9 输出效率
    '保持行动直到任务完成', // 10 自主坚持
    '密钥只存在服务端', // 11 安全边界
    '不虚构', // 兜底:禁止虚构操作结果
  ]
  for (const key of requiredPhrases) {
    it(`contains: ${key}`, () => {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(key)
    })
  }

  it('length guard: <= 3000 Chinese chars', () => {
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(3000)
  })

  it('contains the plan-mode notice', () => {
    expect(PLAN_SYSTEM_NOTICE).toBe(
      '当前处于计划(只读)模式:只可读取文件/搜索/浏览页面/查询知识库,禁止任何写入、修改、删除、执行命令或浏览器操作;' +
        '请调研后输出清晰的执行计划(步骤、涉及文件、预期结果),不要执行任何操作。'
    )
  })

  it('buildSystemPrompt appends skill instructions', () => {
    const withSkill = buildSystemPrompt('\n## Skills\n- foo')
    expect(withSkill).toContain('## Skills')
    expect(withSkill).toBe(DEFAULT_SYSTEM_PROMPT + '\n## Skills\n- foo')
  })

  it('buildSystemPrompt without extra returns base only', () => {
    expect(buildSystemPrompt()).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(buildSystemPrompt(undefined)).toBe(DEFAULT_SYSTEM_PROMPT)
  })
})
