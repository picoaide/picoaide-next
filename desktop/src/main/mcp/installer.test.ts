import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../gateway/config'

const mocks = vi.hoisted(() => ({
  getMcpConfig: vi.fn(),
}))

vi.mock('../gateway/marketplace', () => ({
  getMcpConfig: mocks.getMcpConfig,
}))

import { clearCredentials, getCredentials, installPlugin, installedMcpList, refreshPluginCredentials, setMcpEnabled, uninstallPlugin } from './installer'

const dirs: string[] = []

function mcpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'picoaide-mcp-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
  clearCredentials()
  vi.clearAllMocks()
})

beforeEach(() => {
  clearCredentials()
})

const SESSION: Session = { serverURL: 'https://gw.example.com', username: 'alice', token: 'tok' }

const CFG = {
  id: 1,
  name: 'xiaohongshu',
  description: '小红书笔记采集',
  transport: 'http',
  command: '',
  args: [],
  url: 'http://127.0.0.1:3000/mcp',
  env: { APP_ID: 'decrypted-app-id' },
  headers: { Authorization: 'Bearer decrypted-secret' },
}

const deps = { getSetting: () => null, setSetting: () => {} }

describe('installPlugin', () => {
  it('persists non-sensitive config only and keeps credentials in memory', async () => {
    mocks.getMcpConfig.mockResolvedValue(CFG)
    const dir = mcpDir()

    const rec = await installPlugin({ session: SESSION, id: 1, deps, mcpDir: dir })

    expect(rec).toMatchObject({ id: 1, name: 'xiaohongshu', transport: 'http', url: 'http://127.0.0.1:3000/mcp', enabled: true })
    expect(rec).not.toHaveProperty('env')
    expect(rec).not.toHaveProperty('headers')

    const raw = readFileSync(join(dir, '1', 'config.json'), 'utf8')
    expect(raw).not.toContain('decrypted-app-id')
    expect(raw).not.toContain('decrypted-secret')
    expect(raw).not.toContain('env')
    expect(raw).not.toContain('headers')

    // 凭证仅内存
    expect(getCredentials(1)).toEqual({ env: CFG.env, headers: CFG.headers })
  })

  it('writes config.json with 0600 permissions', async () => {
    mocks.getMcpConfig.mockResolvedValue(CFG)
    const dir = mcpDir()

    await installPlugin({ session: SESSION, id: 1, deps, mcpDir: dir })

    const mode = statSync(join(dir, '1', 'config.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('surfaces 404 and 429 from the marketplace as typed errors', async () => {
    const dir = mcpDir()
    mocks.getMcpConfig.mockRejectedValue({ kind: 'not_found', message: '下架' })
    await expect(installPlugin({ session: SESSION, id: 999, deps, mcpDir: dir })).rejects.toMatchObject({ kind: 'not_found' })

    mocks.getMcpConfig.mockRejectedValue({ kind: 'rate_limited', message: 'slow' })
    await expect(installPlugin({ session: SESSION, id: 999, deps, mcpDir: dir })).rejects.toMatchObject({ kind: 'rate_limited' })
    expect(existsSync(join(dir, '999'))).toBe(false)
  })
})

describe('installedMcpList / setMcpEnabled / uninstallPlugin', () => {
  it('lists installed plugins from the config dir', async () => {
    mocks.getMcpConfig.mockResolvedValue(CFG)
    const dir = mcpDir()
    await installPlugin({ session: SESSION, id: 1, deps, mcpDir: dir })

    const list = installedMcpList(dir)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 1, name: 'xiaohongshu', enabled: true })
  })

  it('toggles enabled state persistently', async () => {
    mocks.getMcpConfig.mockResolvedValue(CFG)
    const dir = mcpDir()
    await installPlugin({ session: SESSION, id: 1, deps, mcpDir: dir })

    const off = setMcpEnabled({ id: 1, enabled: false, mcpDir: dir })
    expect(off.enabled).toBe(false)
    expect(installedMcpList(dir)[0].enabled).toBe(false)

    const on = setMcpEnabled({ id: 1, enabled: true, mcpDir: dir })
    expect(on.enabled).toBe(true)
  })

  it('uninstalls: removes dir and clears memory credentials', async () => {
    mocks.getMcpConfig.mockResolvedValue(CFG)
    const dir = mcpDir()
    await installPlugin({ session: SESSION, id: 1, deps, mcpDir: dir })

    uninstallPlugin({ id: 1, mcpDir: dir })

    expect(existsSync(join(dir, '1'))).toBe(false)
    expect(installedMcpList(dir)).toHaveLength(0)
    expect(getCredentials(1)).toBeUndefined()
  })
})

describe('refreshPluginCredentials', () => {
  it('re-fetches credentials into memory on startup (never persisted)', async () => {
    mocks.getMcpConfig.mockResolvedValue(CFG)
    const dir = mcpDir()
    await installPlugin({ session: SESSION, id: 1, deps, mcpDir: dir })
    clearCredentials()
    expect(getCredentials(1)).toBeUndefined()

    const fresh = { ...CFG, env: { APP_ID: 'refreshed-id' }, headers: { Authorization: 'Bearer refreshed-secret' } }
    mocks.getMcpConfig.mockResolvedValue(fresh)

    const result = await refreshPluginCredentials({ session: SESSION, mcpDir: dir, deps })

    expect(getCredentials(1)).toEqual({ env: fresh.env, headers: fresh.headers })
    expect(result).toEqual([{ id: 1, status: 'ok' }])
    const raw = readFileSync(join(dir, '1', 'config.json'), 'utf8')
    expect(raw).not.toContain('refreshed-secret')
  })

  it('marks a plugin disabled when the server 404s (下架)', async () => {
    mocks.getMcpConfig.mockResolvedValueOnce(CFG)
    const dir = mcpDir()
    await installPlugin({ session: SESSION, id: 1, deps, mcpDir: dir })

    mocks.getMcpConfig.mockRejectedValue({ kind: 'not_found', message: '下架' })
    const result = await refreshPluginCredentials({ session: SESSION, mcpDir: dir, deps })

    expect(result).toEqual([{ id: 1, status: 'disabled' }])
    expect(installedMcpList(dir)[0].enabled).toBe(false)
    expect(getCredentials(1)).toBeUndefined()
  })

  it('ignores unknown installed dirs', async () => {
    const dir = mcpDir()
    const result = await refreshPluginCredentials({ session: SESSION, mcpDir: dir, deps })
    expect(result).toEqual([])
  })
})
