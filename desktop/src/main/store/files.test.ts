import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFilesRecursive } from './files'

it('递归枚举文件,跳过 node_modules/.git,限深度', () => {
  const root = join(tmpdir(), 'files-test-' + Date.now())
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'x.txt'), 'x')
  writeFileSync(join(root, 'a', 'y.md'), 'y')
  writeFileSync(join(root, 'a', 'b', 'z.log'), 'z')
  writeFileSync(join(root, 'node_modules', 'skip.txt'), 's')
  try {
    const files = listFilesRecursive([root])
    expect(files).toContain(join(root, 'x.txt'))
    expect(files).toContain(join(root, 'a', 'y.md'))
    expect(files).toContain(join(root, 'a', 'b', 'z.log'))
    expect(files.some((f) => f.includes('node_modules'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('不存在的目录返回空', () => {
  expect(listFilesRecursive([join(tmpdir(), 'nope-' + Date.now())])).toEqual([])
})
