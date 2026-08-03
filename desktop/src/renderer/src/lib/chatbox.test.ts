import { describe, expect, it } from 'vitest'
import { parseCommandLine, parseMentionLine } from './chatbox'

describe('parseCommandLine', () => {
  it('首字符 / 且有内容时返回命令行状态', () => {
    expect(parseCommandLine('使用', ['技能A', '技能B'])).toBeNull()
    expect(parseCommandLine('/', ['技能A', '技能B'])).toEqual({ kind: 'command', query: '', items: ['技能A', '技能B'] })
    expect(parseCommandLine('/能B', ['技能A', '技能B'])).toEqual({ kind: 'command', query: '能B', items: ['技能B'] })
    expect(parseCommandLine('/技能A 之后', ['技能A'])).toBeNull() // 命中后继续输入 → 关闭
  })
})

describe('parseMentionLine', () => {
  const files = ['/p/a.md', '/p/b.txt']
  const skills = ['s1', 's2']
  it('行尾 @ 或 @查询 时返回提及候选', () => {
    expect(parseMentionLine('帮我读', files, skills)).toBeNull()
    expect(parseMentionLine('帮我读 @', files, skills)).toEqual({
      kind: 'mention', query: '', files: ['/p/a.md', '/p/b.txt'], skills: ['s1', 's2'],
    })
    expect(parseMentionLine('帮我读 @a', files, skills)).toEqual({
      kind: 'mention', query: 'a', files: ['/p/a.md'], skills: [],
    })
    expect(parseMentionLine('帮我读 @s1 吧', files, skills)).toBeNull() // @ 不在行尾
  })
})
