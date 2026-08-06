import type { Tool } from 'ai'
import { z } from 'zod'
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'

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

export function createSandboxTool(sandbox: HarnessV1SandboxProvider): Tool {
  return {
    description:
      '在本地受限 bash 沙盒中执行命令(JS 模拟 bash + 虚拟文件系统,无本机文件访问权限;仅内置命令集,不支持 python3;数据不出本机)',
    inputSchema: z.object({
      command: z.string(),
      timeoutSec: z.number().optional(),
    }),
    execute: async ({ command, timeoutSec }, options) => {
      const session = await sandbox.createSession()
      // 引擎取消信号 + 命令超时合并为一个 controller:just-bash 的 run 对 abort 不敏感,
      // abort 后必须 stop 会话才能让挂起的 run 立即结束(否则会话泄漏、卡到超时)
      const external = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal
      const controller = new AbortController()
      const onExternalAbort = () => controller.abort(new Error('任务已取消'))
      external?.addEventListener('abort', onExternalAbort, { once: true })
      const effective = timeoutSec && timeoutSec > 0 ? timeoutSec : DEFAULT_TIMEOUT_SEC
      const timer = setTimeout(() => controller.abort(new Error(`命令超时(${effective}s)`)), effective * 1000)
      try {
        const result = await Promise.race([
          session.run({ command, abortSignal: controller.signal }),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => {
                void Promise.resolve(session.stop()).catch(() => {})
                reject(controller.signal.reason ?? new Error('命令已取消'))
              },
              { once: true },
            )
          }),
        ])
        return { exitCode: result.exitCode, stdout: truncateOutput(result.stdout), stderr: truncateOutput(result.stderr) }
      } finally {
        external?.removeEventListener('abort', onExternalAbort)
        clearTimeout(timer)
        try {
          await session.stop()
        } catch {
          /* 已 stop */
        }
      }
    },
  }
}
