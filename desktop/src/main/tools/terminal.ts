import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isAllowed } from './paths'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
  timedOut?: boolean
}

export interface CommandOpts {
  cwd: string
  timeoutSec?: number
  maxOutput?: number
  // 审批门控在引擎层消费;此处保留签名供上层透传(审批=执行的同一命令串)
  allowedDirs: string[]
}

export const TRUNCATED_MARKER = '…[输出截断]'
export const TIMEOUT_STDERR = '命令超时'
const DEFAULT_TIMEOUT_SEC = 60
const DEFAULT_MAX_OUTPUT = 50 * 1024

export async function commandExec(command: string, opts: CommandOpts): Promise<CommandResult> {
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT
  const timeoutMs = (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000
  return new Promise<CommandResult>((resolveResult) => {
    // detached(posix)使 shell 成为进程组组长,超时才能 kill(-pid) 整组,防 sleep 等子进程残留
    const child = spawn(command, { shell: true, cwd: opts.cwd, detached: process.platform !== 'win32' })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const settle = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({ stdout, stderr, code, ...(timedOut ? { timedOut: true } : {}) })
    }

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      stderr = TIMEOUT_STDERR
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* 进程已退出 */
        }
      }
      // SIGKILL 后等 close 收尾;2s 兜底,防 kill 失败挂死
      const grace = setTimeout(() => settle(124), 2000)
      grace.unref()
    }, timeoutMs)

    const appendCapped = (buf: string, chunk: Buffer, max: number): string => {
      if (buf.length >= max) return buf
      const need = max - buf.length
      return chunk.length > need ? buf + chunk.toString('utf8', 0, need) + TRUNCATED_MARKER : buf + chunk.toString('utf8')
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk, maxOutput)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk, maxOutput)
    })
    child.on('error', (err) => {
      stderr = stderr || err.message
      settle(127)
    })
    child.on('close', (code) => settle(timedOut ? 124 : code ?? 1))
  })
}

// ---- 命令审批判定(防绕过,架构设计 §3.4) ----
// 任一规则命中 → true(需要用户审批);命中后引擎弹窗展示并执行的命令串 = 判定串,不二次拼接

const WHITELIST = new Set([
  'ls', 'cat', 'pwd', 'mkdir', 'cp', 'mv', 'echo', 'head', 'tail', 'grep', 'wc', 'date', 'df', 'du', 'uname',
])
// find 刻意不在白名单(-exec/-delete 可递归删除)

// 控制字符(含 \n \r \0)与裸 $:命令注入总入口,判定前一律拒绝
const CONTROL_RE = /[\x00-\x1f\x7f]/
const BARE_DOLLAR_RE = /\$/
// shell 拼接/重定向/后台:; && || | 反引号 > <(计划列 &&,统一拒 & 连同裸 & 一并覆盖)
const SHELL_CHAR_RE = /[;|&<>`]/

export function needsApprovalFor(command: string, allowedDirs: string[]): boolean {
  if (!command.trim()) return true
  if (CONTROL_RE.test(command) || BARE_DOLLAR_RE.test(command) || SHELL_CHAR_RE.test(command)) return true
  const first = command.trimStart().split(/\s+/, 1)[0]
  if (!WHITELIST.has(first)) return true
  for (const raw of command.split(/\s+/)) {
    const arg = stripQuotes(raw.trim())
    if (!arg || arg === '-' || arg.startsWith('-')) continue
    // ponytail: 通配符/赋值 token 不判路径(天花板:cat *.txt 靠白名单+弹窗展示兜底;
    // 精确 glob 展开留给未来若出现真实绕过)
    if (/[*?{}\[\]"'=]/.test(arg)) continue
    if (!isPathLike(arg)) continue
    if (!isAllowed(expandHome(arg), allowedDirs)) return true
  }
  return false
}

// 剥离首尾成对引号后仍按路径判定(cat '/etc/passwd' 引号包裹一样被拒);残留引号的病态拼接跳过
function stripQuotes(s: string): string {
  const q = s[0]
  if ((q === "'" || q === '"') && s.length >= 2 && s.endsWith(q)) return s.slice(1, -1)
  return s
}

// 仅处理绝对 / ~ / . 开头、含 / 或相对 cwd 真实存在的 token(echo hi 之类普通词不误判)
function isPathLike(arg: string): boolean {
  if (arg.startsWith('/') || arg.startsWith('~') || arg.startsWith('.')) return true
  if (arg.includes('/')) return true
  try {
    return existsSync(resolve(process.cwd(), arg))
  } catch {
    return false
  }
}

function expandHome(arg: string): string {
  const home = process.env.HOME
  if (arg === '~') return home ?? arg
  if (arg.startsWith('~/') && home) return join(home, arg.slice(2))
  return arg
}
