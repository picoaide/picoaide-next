import type { Tool } from 'ai'
import { z } from 'zod'
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils'

export const SANDBOX_MAX_OUTPUT_CHARS = 50 * 1024
const TRUNCATE_MARKER = '\n...[输出已截断]'
// 未指定超时的兜底:挂起的沙盒命令永不返回会卡死整个对话步骤(且 finally 的 session.stop 不执行)
const DEFAULT_TIMEOUT_SEC = 60

// 本地受限会话执行,数据不出本机、无用户文件访问权限 → 不触发审批(引擎 wiring 由后续任务完成)
export const HIGH_RISK_TOOLS: string[] = []

let providerPromise: Promise<HarnessV1SandboxProvider> | null = null

// 惰性动态 import:@ai-sdk/sandbox-just-bash 体积大,仅首次调用加载;动态 import 使 vitest 可用 vi.mock 拦截
export function getSandbox(): Promise<HarnessV1SandboxProvider> {
  if (!providerPromise) {
    providerPromise = import('@ai-sdk/sandbox-just-bash').then((m) => m.createJustBashSandbox())
  }
  return providerPromise
}

export function truncateOutput(s: string): string {
  if (s.length <= SANDBOX_MAX_OUTPUT_CHARS) return s
  return s.slice(0, SANDBOX_MAX_OUTPUT_CHARS) + TRUNCATE_MARKER
}

// ponytail: per-command 超时走 abortSignal(run 的原生机制);just-bash 全局 timeoutMs 需建会话时设定,粒度太粗
async function runCommand(session: Experimental_SandboxSession, command: string, timeoutSec?: number) {
  const abort = new AbortController()
  const effective = timeoutSec && timeoutSec > 0 ? timeoutSec : DEFAULT_TIMEOUT_SEC
  const timer = setTimeout(() => abort.abort(new Error(`命令超时(${effective}s)`)), effective * 1000)
  try {
    return await session.run({ command, abortSignal: abort.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function createSandboxTool(sandbox: HarnessV1SandboxProvider): Tool {
  return {
    description:
      '在本地受限 bash 沙盒中执行命令(JS 模拟 bash + 虚拟文件系统,无本机文件访问权限;仅内置命令集,不支持 python3;数据不出本机)',
    inputSchema: z.object({
      command: z.string(),
      timeoutSec: z.number().optional(),
    }),
    execute: async ({ command, timeoutSec }) => {
      const session = await sandbox.createSession()
      try {
        const result = await runCommand(session, command, timeoutSec)
        return { exitCode: result.exitCode, stdout: truncateOutput(result.stdout), stderr: truncateOutput(result.stderr) }
      } finally {
        await session.stop()
      }
    },
  }
}
