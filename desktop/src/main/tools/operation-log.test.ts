import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { initOperationLog, logOperation } from './operation-log'
import { setDataDirOverride } from '../paths'

const dir = mkdtempSync(join(tmpdir(), 'oplog-test-'))

afterAll(() => {
  setDataDirOverride(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('operation-log', () => {
  it('rotates the log file by day once it exceeds 5MB', () => {
    setDataDirOverride(dir)
    initOperationLog()
    // 直接构造一个超过轮转阈值的日志文件,再触发一次写入
    writeFileSync(join(dir, 'operation.log'), 'x'.repeat(5 * 1024 * 1024))
    logOperation('probe', 'rotate me')

    const rotated = readdirSync(dir).filter((f) => f.startsWith('operation.log.') && f !== 'operation.log')
    expect(rotated.length).toBe(1)
    const fresh = readFileSync(join(dir, 'operation.log'), 'utf8')
    expect(fresh).toContain('probe')
  })
})
