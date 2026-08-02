import fs from 'node:fs'
import path from 'node:path'

// 工具执行错误:AI SDK 记为 tool_error 回传模型(与审批拒绝同路径)
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

// 最长已存在祖先 realpath 化 + 剩余段拼接;路径或其祖先含符号链接时按真实位置比较
function resolveExistingPath(p: string): string {
  const remainder: string[] = []
  let cur = path.resolve(p)
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...remainder)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.join(cur, ...remainder)
      remainder.unshift(path.basename(cur))
      cur = parent
    }
  }
}

const CASE_INSENSITIVE = process.platform === 'win32'

function norm(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p
}

export function isAllowed(absPath: string, allowedDirs: string[]): boolean {
  const resolved = norm(resolveExistingPath(absPath))
  for (const dir of allowedDirs) {
    const d = norm(resolveExistingPath(dir))
    if (resolved === d) return true
    // 前缀边界:allowed + path.sep,避免 /home/u/ab 满足 /home/u/a
    const boundary = d.endsWith(path.sep) ? d : d + path.sep
    if (resolved.startsWith(boundary)) return true
  }
  return false
}

export function getAllowedDirsFromSettings(getSetting: (k: string) => string | null): string[] {
  const raw = getSetting('allowed_dirs')
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

export function resolveAllowedDirs(workspaceDir: string, raw: string[]): string[] {
  const out = [workspaceDir]
  for (const d of raw) if (!out.includes(d)) out.push(d)
  return out
}
