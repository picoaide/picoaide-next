import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMcpRunner, validateArgs, validateStdioCommand } from './runner'

const FIXTURE = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'mock-mcp-server.js')
const NODE = process.execPath
// 测试跑在 ELECTRON_RUN_AS_NODE 下时,execPath 是 electron 二进制,spawn 子进程需带上该环境变量
const SPAWN_ENV: Record<string, string> = process.execPath.includes('electron')
  ? { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' }
  : (process.env as Record<string, string>)

function stdioRunner() {
  return createMcpRunner({ transport: 'stdio', command: NODE, args: [FIXTURE], env: SPAWN_ENV })
}

describe('validateStdioCommand', () => {
  it('accepts absolute paths and whitelisted bare names', () => {
    expect(validateStdioCommand(NODE)).toBeNull()
    expect(validateStdioCommand('/usr/bin/python3')).toBeNull()
    for (const cmd of ['npx', 'node', 'python3', 'docker']) {
      expect(validateStdioCommand(cmd)).toBeNull()
    }
  })

  it('rejects non-whitelisted bare names and empty commands', () => {
    expect(validateStdioCommand('evil-server')).toMatch(/白名单/)
    expect(validateStdioCommand('')).toMatch(/白名单|为空/)
  })
})

describe('validateArgs', () => {
  it('rejects shell metacharacters', () => {
    for (const bad of ['pkg;rm -rf /', 'x & y', 'a|b', '`ls`', '$HOME', 'a < b', 'a > b', 'a\nb']) {
      expect(validateArgs([bad]), `arg ${JSON.stringify(bad)}`).toMatch(/元字符/)
    }
  })

  it('accepts ordinary args', () => {
    expect(validateArgs(['-y', 'pkg', '--flag=1'])).toBeNull()
    expect(validateArgs([])).toBeNull()
  })
})

describe('createMcpRunner (stdio)', () => {
  it('connects, lists tools and calls a tool', async () => {
    const runner = stdioRunner()
    try {
      const tools = await runner.listTools()
      expect(tools.map((t) => t.name)).toContain('mock_echo')
      expect(tools[0].inputSchema).toBeTruthy()

      const result = await runner.callTool('mock_echo', { text: 'hi' })
      expect(JSON.stringify(result)).toContain('echo:hi')
    } finally {
      await runner.close()
    }
  })

  it('auto-restarts once after a crash, then serves calls', async () => {
    const runner = stdioRunner()
    try {
      await runner.listTools()
      await expect(runner.callTool('mock_crash', {})).rejects.toThrow()

      // listTools 会等待重启完成
      const tools = await runner.listTools()
      expect(tools.map((t) => t.name)).toContain('mock_echo')
      expect(runner.restartCount()).toBe(1)

      const result = await runner.callTool('mock_echo', { text: 'again' })
      expect(JSON.stringify(result)).toContain('echo:again')
    } finally {
      await runner.close()
    }
  })

  it('disables and emits a disabled event after a second crash', async () => {
    const runner = stdioRunner()
    try {
      await runner.listTools()
      await expect(runner.callTool('mock_crash', {})).rejects.toThrow()
      await runner.listTools() // 第一次重启完成

      const disabled = new Promise<void>((resolve) => runner.onDisabled(() => resolve()))
      await expect(runner.callTool('mock_crash', {})).rejects.toThrow()

      await disabled
      expect(runner.isDisabled()).toBe(true)
      await expect(runner.callTool('mock_echo', { text: 'x' })).rejects.toThrow(/停用|disabled/)
    } finally {
      await runner.close()
    }
  })

  it('refuses to start for a non-whitelisted command', () => {
    expect(() => createMcpRunner({ transport: 'stdio', command: 'evil-server', args: [] })).toThrow(/白名单/)
    expect(() => createMcpRunner({ transport: 'stdio', command: NODE, args: ['pkg;rm'] })).toThrow(/元字符/)
  })

  it('disables when the process cannot start (ENOENT-like)', async () => {
    const runner = createMcpRunner({ transport: 'stdio', command: join(FIXTURE, 'no-such-dir', 'missing.js'), args: [] })
    try {
      const disabled = new Promise<void>((resolve) => runner.onDisabled(() => resolve()))
      await disabled
      expect(runner.isDisabled()).toBe(true)
    } finally {
      await runner.close()
    }
  })
})

describe('createMcpRunner (http)', () => {
  it('refuses a non-absolute/whitelist-invalid config at construction', () => {
    expect(() =>
      createMcpRunner({ transport: 'http', url: 'not-a-url', headers: { Authorization: 'Bearer x' } }),
    ).toThrow(/URL/)
  })

  it('disables after failing to connect', async () => {
    const runner = createMcpRunner({ transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } })
    try {
      const disabled = new Promise<void>((resolve) => runner.onDisabled(() => resolve()))
      await disabled
      expect(runner.isDisabled()).toBe(true)
    } finally {
      await runner.close()
    }
  })

  it('uses the injected session fetch for the HTTP transport (TOFU path)', async () => {
    const injectedFetch = vi.fn() as unknown as typeof fetch
    const runner = createMcpRunner({
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp',
      headers: { Authorization: 'Bearer x' },
      fetch: injectedFetch,
    })
    try {
      // transport 构造即把注入的 fetch 交给 StreamableHTTPClientTransport
      expect(runner.transportFetch).toBe(injectedFetch)
      // 且 transport 未被全局 fetch 替代
      expect(runner.transportFetch).not.toBe(undefined)
    } finally {
      await runner.close()
    }
  })
})
