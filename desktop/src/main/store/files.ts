import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_DEPTH = 3
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.picoaide-data'])

// 递归枚举文件(深度 ≤3,排除噪音目录);roots 需经调用方校验在可访问目录内
export function listFilesRecursive(roots: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          // 目录也返回:输入框 @ 提及需要匹配文件夹(agent 可列出/读取目录)
          out.push(full)
          walk(full, depth + 1)
        } else out.push(full)
      } catch {
        // ignore unreadable
      }
    }
  }
  for (const root of roots) walk(root, 0)
  return out.sort()
}
