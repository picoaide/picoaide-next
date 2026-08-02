import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commandExec, needsApprovalFor, TRUNCATED_MARKER } from './terminal'

describe('commandExec', () => {
  let tmp: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'picoaide-terminal-'))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('echo hello → stdout + exit 0', async () => {
    const r = await commandExec('echo hello', { cwd: tmp, timeoutSec: 5, allowedDirs: [tmp] })
    expect(r.stdout.trim()).toBe('hello')
    expect(r.code).toBe(0)
    expect(r.timedOut).toBeUndefined()
  })

  it('sleep 5 with 1s timeout → killed quickly, code 124', async () => {
    const started = Date.now()
    const r = await commandExec('sleep 5', { cwd: tmp, timeoutSec: 1, allowedDirs: [tmp] })
    const elapsed = Date.now() - started
    expect(r.timedOut).toBe(true)
    expect(r.code).toBe(124)
    expect(r.stderr).toBe('命令超时')
    // 若进程组 kill 未生效,sleep 5 需 ~5s 才返回
    expect(elapsed).toBeLessThan(4000)
  })

  it('truncates output at maxOutput with marker', async () => {
    const big = join(tmp, 'big.txt')
    writeFileSync(big, 'a'.repeat(10 * 1024))
    const r = await commandExec(`cat ${big}`, { cwd: tmp, timeoutSec: 5, maxOutput: 2048, allowedDirs: [tmp] })
    expect(r.stdout.length).toBeLessThanOrEqual(2048 + TRUNCATED_MARKER.length)
    expect(r.stdout.endsWith(TRUNCATED_MARKER)).toBe(true)
    expect(r.code).toBe(0)
  })
})

describe('needsApprovalFor', () => {
  // it.each 表在收集期求值,目录须同步创建(chdir 等副作用留在 beforeAll)
  const tmp = mkdtempSync(join(tmpdir(), 'picoaide-approval-'))
  const outside = mkdtempSync(join(tmpdir(), 'picoaide-outside-'))
  let prevCwd: string

  beforeAll(() => {
    mkdirSync(join(tmp, 'allowed'))
    writeFileSync(join(tmp, 'a.md'), 'x')
    writeFileSync(join(outside, 'x'), 'x')
    prevCwd = process.cwd()
    process.chdir(tmp)
  })

  afterAll(() => {
    process.chdir(prevCwd)
    rmSync(tmp, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it.each([
    ['ls -la', false],
    ['cat a.md', false],
    ['cat /etc/passwd', true],
    [';rm -rf /', true],
    ['$(rm -rf /)', true],
    ['rm -rf /', true],
    ['/usr/bin/rm x', true],
    ['cat a > out.txt', true],
    ['find . -delete', true],
    ['ls\nrm -rf /', true],
    ['cat $HOME/.ssh/id_rsa', true],
    ['echo hi', false],
    ['uname -a', false],
    [`cat ${outside}/x`, true],
    [`mkdir ${tmp}/allowed/newdir`, false],
    ['', true],
    ['   ', true],
  ])('%s → %s', (cmd, expected) => {
    expect(needsApprovalFor(cmd, [tmp])).toBe(expected)
  })

  it('quoted absolute path is still rejected (quote strip)', () => {
    expect(needsApprovalFor("cat '/etc/passwd'", [tmp])).toBe(true)
    expect(needsApprovalFor(`cat '${tmp}/a.md'`, [tmp])).toBe(false)
  })

  it('glob/brace targets cannot bypass the path check', () => {
    expect(needsApprovalFor('cat /etc/*', [tmp])).toBe(true)
    expect(needsApprovalFor('cat /etc/*.conf', [tmp])).toBe(true)
    expect(needsApprovalFor('mkdir /root/{a,b}', [tmp])).toBe(true)
    expect(needsApprovalFor('cat ../*.md', [tmp])).toBe(true)
    expect(needsApprovalFor('cat *.md', [tmp])).toBe(false)
    expect(needsApprovalFor('cat *', [tmp])).toBe(false)
  })
})
