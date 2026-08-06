// 统一 debug 日志:PICOAI_DEBUG=1 开启,输出到控制台 + <dataDir>/picoaide-debug.log
// 生产包双击启动无终端,文件日志是唯一可查位置;结构级日志,不打正文/密钥
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let logFile: string | null = null

// index.ts 启动时调用,传入 dataDir();幂等
export function initDebugLog(dataDir: string): void {
  if (!isEnabled()) return
  try {
    mkdirSync(dataDir, { recursive: true })
    const file = join(dataDir, 'picoaide-debug.log')
    // 每次启动截断,避免无限增长
    writeFileSync(file, `# picoaide-debug log ${new Date().toISOString()}\n`)
    logFile = file
  } catch {
    logFile = null // 文件不可写则仅控制台
  }
}

export function isEnabled(): boolean {
  return process.env.PICOAI_DEBUG === '1' && process.env.NODE_ENV !== 'test'
}

export function debugLog(...args: unknown[]): void {
  if (!isEnabled()) return
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  console.log('[picoaide-debug]', line)
  if (logFile) {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      // 写日志失败不影响业务
    }
  }
}
