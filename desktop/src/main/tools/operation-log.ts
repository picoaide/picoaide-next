import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../paths'

// 操作审计日志(chatbox operation-log):命令/工具执行落盘,问题排查用
// ponytail: 单文件追加,不轮转;量大时再按天轮转
let logPath: string | null = null

export function initOperationLog(): void {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  logPath = join(dir, 'operation.log')
}

export function logOperation(op: string, detail: string): void {
  if (!logPath) return
  try {
    const ts = new Date().toISOString()
    appendFileSync(logPath, `[${ts}] ${op} ${detail}\n`)
  } catch {
    // 日志失败不阻塞业务
  }
}
