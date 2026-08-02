import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'
import { createSandboxTool, getSandbox, truncateOutput } from './sandbox'

const mocks = vi.hoisted(() => ({
  createJustBashSandbox: vi.fn(),
  run: vi.fn(),
  stop: vi.fn(),
  createSession: vi.fn(),
}))

vi.mock('@ai-sdk/sandbox-just-bash', () => ({ createJustBashSandbox: mocks.createJustBashSandbox }))

function makeProvider() {
  return { createSession: mocks.createSession } as unknown as HarnessV1SandboxProvider
}

function toolOptions() {
  return { toolCallId: 'call_1' } as never
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.createSession.mockResolvedValue({ run: mocks.run, stop: mocks.stop })
})

describe('createSandboxTool', () => {
  it('runs the command in a sandbox session and stops it after', async () => {
    mocks.run.mockResolvedValue({ exitCode: 0, stdout: 'hello\n', stderr: '' })
    const tool = createSandboxTool(makeProvider())

    const out = await tool.execute!({ command: 'cat hello.txt' }, toolOptions())

    expect(out).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' })
    expect(mocks.createSession).toHaveBeenCalledTimes(1)
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ command: 'cat hello.txt' }))
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })

  it('truncates stdout and stderr at 50KB with a marker', async () => {
    const big = 'x'.repeat(60 * 1024)
    mocks.run.mockResolvedValue({ exitCode: 1, stdout: big, stderr: big })
    const tool = createSandboxTool(makeProvider())

    const out = await tool.execute!({ command: 'make', timeoutSec: 30 }, toolOptions())

    expect(out.stdout.length).toBeLessThan(51 * 1024)
    expect(out.stdout.endsWith('...[输出已截断]')).toBe(true)
    expect(out.stderr).toMatch(/输出已截断/)
  })

  it('passes an abort signal when timeoutSec is set', async () => {
    mocks.run.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    const tool = createSandboxTool(makeProvider())

    await tool.execute!({ command: 'sleep 5', timeoutSec: 1 }, toolOptions())

    const opts = mocks.run.mock.calls[0][0]
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('propagates run errors to the caller', async () => {
    mocks.run.mockRejectedValue(new Error('boom'))
    const tool = createSandboxTool(makeProvider())

    await expect(tool.execute!({ command: 'bad' }, toolOptions())).rejects.toThrow('boom')
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })
})

describe('getSandbox', () => {
  it('creates a lazy singleton provider', async () => {
    const provider = makeProvider()
    mocks.createJustBashSandbox.mockReturnValue(provider)

    const p1 = await getSandbox()
    const p2 = await getSandbox()

    expect(p1).toBe(provider)
    expect(p2).toBe(provider)
    expect(mocks.createJustBashSandbox).toHaveBeenCalledTimes(1)
  })
})

describe('truncateOutput', () => {
  it('keeps short output intact', () => {
    expect(truncateOutput('hi')).toBe('hi')
  })
})

// 能力边界探测(仅 RUN_SANDBOX_PROBE=1 时执行):just-bash 是否支持 python3(计划 3.3 要求实测)
describe.skipIf(!process.env.RUN_SANDBOX_PROBE)('probe: just-bash python3 capability', () => {
  it('python3 --version in a real sandbox', async () => {
    const { createJustBashSandbox } = await vi.importActual<typeof import('@ai-sdk/sandbox-just-bash')>('@ai-sdk/sandbox-just-bash')
    const session = await createJustBashSandbox().createSession()
    const r = await session.run({ command: 'python3 --version' })
    console.log('[probe] python3 --version →', JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }))
    expect(typeof r.exitCode).toBe('number')
    await session.stop()
  })
})
