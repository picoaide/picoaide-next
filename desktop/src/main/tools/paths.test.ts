import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getAllowedDirsFromSettings, isAllowed, resolveAllowedDirs, resolveWorkspace } from './paths'

const dirs: string[] = []

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('isAllowed', () => {
  it('allows paths inside an allowed dir', () => {
    const t = makeTmp()
    expect(isAllowed(path.join(t, 'a', 'b.txt'), [t])).toBe(true)
  })

  it('allows the allowed dir itself', () => {
    const t = makeTmp()
    expect(isAllowed(t, [t])).toBe(true)
  })

  it('rejects paths outside allowed dirs', () => {
    const t = makeTmp()
    expect(isAllowed('/etc/passwd', [t])).toBe(false)
  })

  it('prefix boundary: /home/u/a must not satisfy allowed /home/u/ab', () => {
    const t = makeTmp()
    const allowed = path.join(t, 'ab')
    fs.mkdirSync(allowed)
    expect(isAllowed(path.join(t, 'a'), [allowed])).toBe(false)
    expect(isAllowed(path.join(t, 'ab'), [allowed])).toBe(true)
  })

  it('rejects a symlink pointing outside the allowed dir', () => {
    const t = makeTmp()
    fs.symlinkSync('/etc', path.join(t, 'link'))
    expect(isAllowed(path.join(t, 'link', 'passwd'), [t])).toBe(false)
  })

  it('allows a symlink pointing inside the allowed dir', () => {
    const t = makeTmp()
    fs.mkdirSync(path.join(t, 'real'))
    fs.symlinkSync(path.join(t, 'real'), path.join(t, 'link'))
    expect(isAllowed(path.join(t, 'link', 'f.txt'), [t])).toBe(true)
  })

  it('allows a not-yet-existing path under an allowed dir', () => {
    const t = makeTmp()
    expect(isAllowed(path.join(t, 'new', 'dir', 'file.txt'), [t])).toBe(true)
  })

  it('rejects when no allowed dir matches', () => {
    const t = makeTmp()
    expect(isAllowed(path.join(t, 'x'), [])).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('compares case-insensitively on win32', () => {
    expect(isAllowed('C:\\Users\\Foo\\x.txt', ['c:\\users\\foo'])).toBe(true)
    expect(isAllowed('C:\\Users\\Foo2\\x.txt', ['c:\\users\\foo'])).toBe(false)
  })
})

describe('getAllowedDirsFromSettings', () => {
  it('returns [] when the key is missing', () => {
    expect(getAllowedDirsFromSettings(() => null)).toEqual([])
  })

  it('parses the JSON array from allowed_dirs', () => {
    const get = (k: string) => (k === 'allowed_dirs' ? JSON.stringify(['/a', '/b']) : null)
    expect(getAllowedDirsFromSettings(get)).toEqual(['/a', '/b'])
  })

  it('returns [] on invalid JSON', () => {
    expect(getAllowedDirsFromSettings(() => 'not json')).toEqual([])
  })

  it('filters out non-string entries', () => {
    expect(getAllowedDirsFromSettings(() => JSON.stringify(['/a', 42, null, '/b']))).toEqual(['/a', '/b'])
  })
})

describe('resolveAllowedDirs', () => {
  it('always includes the workspace dir first', () => {
    expect(resolveAllowedDirs('/ws', ['/x', '/y'])).toEqual(['/ws', '/x', '/y'])
  })

  it('dedupes the workspace dir from raw entries', () => {
    expect(resolveAllowedDirs('/ws', ['/ws', '/x', '/ws'])).toEqual(['/ws', '/x'])
  })
})

describe('resolveWorkspace', () => {
  it('空串/空白回退 fallback(无项目会话 workspace 默认 \'\')', () => {
    expect(resolveWorkspace('', '/fallback')).toBe('/fallback')
    expect(resolveWorkspace('   ', '/fallback')).toBe('/fallback')
    expect(resolveWorkspace(undefined, '/fallback')).toBe('/fallback')
  })

  it('非空 workspace 原样返回', () => {
    expect(resolveWorkspace('/proj/5', '/fallback')).toBe('/proj/5')
  })
})
