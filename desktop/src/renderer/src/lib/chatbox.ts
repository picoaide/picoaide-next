export interface CommandLine {
  kind: 'command'
  query: string
  items: string[]
}

export interface MentionLine {
  kind: 'mention'
  query: string
  files: string[]
  skills: string[]
}

export type ChatboxLine = CommandLine | MentionLine | null

// 输入行含未完成的 /命令(斜杠开头、有匹配项且不是完整选择后才算"进行中")
export function parseCommandLine(value: string, items: string[]): ChatboxLine {
  if (!value.startsWith('/')) return null
  const trimmed = value.trim()
  if (trimmed.length === 1) return { kind: 'command', query: '', items }
  const query = trimmed.slice(1)
  const matched = items.filter((i) => i.toLowerCase().includes(query.toLowerCase()))
  if (matched.length === 0) return null
  return { kind: 'command', query, items: matched }
}

// 行尾 @ 或 @查询 时返回提及候选(查询同时匹配文件名与技能名)
export function parseMentionLine(value: string, files: string[], skills: string[]): ChatboxLine {
  const m = /@([^\s]*)$/.exec(value)
  if (!m) return null
  const query = m[1].toLowerCase()
  return {
    kind: 'mention',
    query,
    files: files.filter((f) => f.toLowerCase().includes(query)),
    skills: skills.filter((s) => s.toLowerCase().includes(query)),
  }
}
