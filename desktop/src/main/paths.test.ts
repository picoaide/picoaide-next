import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, isPortable, setDataDirOverride } from './paths'

let tmp: string
let origExecPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'paths-test-'))
  origExecPath = process.execPath
  setDataDirOverride(null)
})

afterEach(() => {
  Object.defineProperty(process, 'execPath', { value: origExecPath, configurable: true })
})

function setExecPath(p: string): void {
  Object.defineProperty(process, 'execPath', { value: p, configurable: true })
}

// macOS 一律走标准数据目录(Application Support),不做 portable
describe('portable mode', () => {
  it('无 portable.txt 时不启用 portable', () => {
    setExecPath(join(tmp, 'picoaide', 'picoaide'))
    expect(isPortable()).toBe(false)
  })

  it('exe 同目录存在 portable.txt 时启用 portable,data 目录 = exe 同目录/data(linux)', () => {
    mkdirSync(join(tmp, 'app'), { recursive: true })
    writeFileSync(join(tmp, 'app', 'portable.txt'), '')
    setExecPath(join(tmp, 'app', 'picoaide'))
    expect(isPortable()).toBe(true)
    expect(dataDir()).toBe(join(tmp, 'app', 'data'))
  })

  it('macOS 即使有 portable.txt 也不启用 portable,data 走 Application Support', () => {
    const app = join(tmp, 'app.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(app, 'portable.txt'), '')
    setExecPath(join(app, 'Contents', 'MacOS', 'picoaide'))
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    try {
      expect(isPortable()).toBe(false)
      process.env.HOME = join(tmp, 'home')
      expect(dataDir()).toBe(join(tmp, 'home', 'Library', 'Application Support', 'picoaide'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('portable 目录不可写时回退系统目录', () => {
    // data 目录是文件而非目录 → mkdir 失败 → 回退
    mkdirSync(join(tmp, 'ro'), { recursive: true })
    writeFileSync(join(tmp, 'ro', 'portable.txt'), '')
    writeFileSync(join(tmp, 'ro', 'data'), 'blocked')
    setExecPath(join(tmp, 'ro', 'picoaide'))
    process.env.HOME = join(tmp, 'home')
    expect(dataDir()).toBe(join(tmp, 'home', '.local', 'share', 'picoaide'))
  })

  it('dataDirOverride 优先于 portable', () => {
    mkdirSync(join(tmp, 'app'), { recursive: true })
    writeFileSync(join(tmp, 'app', 'portable.txt'), '')
    setExecPath(join(tmp, 'app', 'picoaide'))
    setDataDirOverride(join(tmp, 'override'))
    expect(dataDir()).toBe(join(tmp, 'override'))
  })
})
