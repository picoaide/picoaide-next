import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../paths'

// 操作审计日志(chatbox operation-log):命令/工具执行落盘,问题排查用
// 轮转:单文件 ≥5MB 时按天改名(operation.log.YYYYMMDD),防日志无限膨胀
const ROTATE_BYTES = 5 * 1024 * 1024
let logPath: string | null = null

export function initOperationLog(): void {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  logPath = join(dir, 'operation.log')
}

function rotateIfNeeded(): void {
  if (!logPath) return
  try {
    const st = statSync(logPath)
    if (st.size < ROTATE_BYTES) return
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const target = `${logPath}.${day}`
    // 同日已轮转过(罕见,5MB 阈值内同一天基本一次):旧档移位保留,不覆盖
    const shifted = existsSync(target) ? `${target}.${Date.now()}` : target
    if (existsSync(target)) renameSync(target, shifted)
    renameSync(logPath, target)
  } catch {
    // 轮转失败不阻塞业务(stat 不存在 = 首次写)
  }
}

export function logOperation(op: string, detail: string): void {
  if (!logPath) return
  try {
    rotateIfNeeded()
    const ts = new Date().toISOString()
    appendFileSync(logPath, `[${ts}] ${op} ${detail}\n`)
  } catch {
    // 日志失败不阻塞业务
  }
}
