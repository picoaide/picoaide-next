import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../gateway/config'
import { installFromMarketplace, listInstalledSkills, previewSkillMeta, removeSkill, SkillInstallError } from './installer'

const dirs: string[] = []

function fixtureDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'picoaide-install-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

const SESSION: Session = { serverURL: 'https://gw.example.com', username: 'alice', token: 'tok' }

// ---- 手工构造 tar 条目(tar 头 512B + 数据块,校验和按标准算法) ----

function tarEntry(name: string, content: string, typeflag = '0', declaredSize?: number): Buffer {
  const data = Buffer.from(content, 'utf8')
  const size = declaredSize ?? data.length
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write(typeflag, 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const b of header) sum += b
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  data.copy(padded)
  return Buffer.concat([header, padded])
}

function makeTarGz(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat(entries))
}

const GOOD_FILES = [
  tarEntry('SKILL.md', '# demo\n'),
  tarEntry('metadata.yaml', 'name: demo\nversion: 1.0.0\nauthor: ops\ndescription: demo skill\nentrypoint: scripts/run.py\n'),
  tarEntry('scripts/run.py', 'print("hello")'),
]

interface FakeDeps {
  getSetting: ReturnType<typeof vi.fn>
  setSetting: ReturnType<typeof vi.fn>
  downloadArchive: ReturnType<typeof vi.fn>
}

function makeDeps(archive: Buffer, version: string, settings: Record<string, string> = {}): FakeDeps {
  return {
    getSetting: vi.fn((k: string) => settings[k] ?? null),
    setSetting: vi.fn((k: string, v: string) => {
      settings[k] = v
    }),
    downloadArchive: vi.fn().mockResolvedValue({ buffer: archive, version }),
  }
}

const installOpts = (deps: FakeDeps, skillsDir: string, onConfirm = vi.fn().mockResolvedValue(true)) => ({
  session: SESSION,
  skillsDir,
  name: 'demo',
  deps,
  onConfirm,
})

describe('installFromMarketplace', () => {
  it('downloads, confirms, extracts and records the version in settings', async () => {
    const dir = fixtureDir()
    const deps = makeDeps(makeTarGz(GOOD_FILES), '1.0.0')
    const onConfirm = vi.fn().mockResolvedValue(true)

    const rec = await installFromMarketplace(installOpts(deps, dir, onConfirm))

    expect(rec).toMatchObject({ version: '1.0.0' })
    expect(rec.installedAt).toBeTruthy()
    expect(readFileSync(join(dir, 'demo', 'SKILL.md'), 'utf8')).toBe('# demo\n')
    expect(readFileSync(join(dir, 'demo', 'scripts', 'run.py'), 'utf8')).toBe('print("hello")')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].name).toBe('demo')
    const installed = listInstalledSkills(deps.getSetting as never)
    expect(installed['demo']).toMatchObject({ version: '1.0.0' })
    expect(installed['demo'].installedAt).toBeTruthy()
    expect(deps.downloadArchive).toHaveBeenCalledWith(SESSION, 'demo')
  })

  it('calls onConfirm with the parsed metadata before extracting', async () => {
    const dir = fixtureDir()
    const deps = makeDeps(makeTarGz(GOOD_FILES), '1.0.0')
    const onConfirm = vi.fn(async (meta: unknown) => {
      expect((meta as { author: string }).author).toBe('ops')
      return true
    })

    await installFromMarketplace(installOpts(deps, dir, onConfirm))
  })

  it('aborts when onConfirm resolves false: no extraction, no settings write', async () => {
    const dir = fixtureDir()
    const deps = makeDeps(makeTarGz(GOOD_FILES), '1.0.0')
    const onConfirm = vi.fn().mockResolvedValue(false)

    await expect(installFromMarketplace(installOpts(deps, dir, onConfirm))).rejects.toThrow(/取消|拒绝|确认/)

    expect(existsSync(join(dir, 'demo'))).toBe(false)
    expect(deps.getSetting('skills.installed')).toBeNull()
    expect(deps.setSetting).not.toHaveBeenCalled()
  })

  it('rejects ../ traversal entries and extracts nothing', async () => {
    const dir = fixtureDir()
    const archive = makeTarGz([...GOOD_FILES, tarEntry('../evil.sh', 'rm -rf /')])
    const deps = makeDeps(archive, '1.0.0')

    await expect(installFromMarketplace(installOpts(deps, dir))).rejects.toThrow(SkillInstallError)
    await expect(installFromMarketplace(installOpts(deps, dir))).rejects.toThrow(/路径/)

    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  it('rejects absolute paths', async () => {
    const dir = fixtureDir()
    const archive = makeTarGz([...GOOD_FILES, tarEntry('/etc/passwd', 'root:x')])
    const deps = makeDeps(archive, '1.0.0')

    await expect(installFromMarketplace(installOpts(deps, dir))).rejects.toThrow(/路径/)
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  it('rejects symlink entries', async () => {
    const dir = fixtureDir()
    const archive = makeTarGz([...GOOD_FILES, tarEntry('scripts/link', 'scripts/run.py', '2')])
    const deps = makeDeps(archive, '1.0.0')

    await expect(installFromMarketplace(installOpts(deps, dir))).rejects.toThrow(/链接|符号|symlink|类型/)
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  it('rejects archives whose total declared size exceeds the cap', async () => {
    const dir = fixtureDir()
    const big = tarEntry('big.bin', 'x', '0', 101 * 1024 * 1024)
    const deps = makeDeps(makeTarGz([...GOOD_FILES, big]), '1.0.0')

    await expect(installFromMarketplace(installOpts(deps, dir))).rejects.toThrow(/大小|100MB/)
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  it('rejects version mismatch between archive header and metadata', async () => {
    const dir = fixtureDir()
    const archive = makeTarGz([
      tarEntry('SKILL.md', '# demo\n'),
      tarEntry('metadata.yaml', 'name: demo\nversion: 2.0.0\n'),
    ])
    const deps = makeDeps(archive, '1.0.0')

    await expect(installFromMarketplace(installOpts(deps, dir))).rejects.toThrow(/版本/)
  })

  it('surfaces marketplace errors (404/429) as typed kinds', async () => {
    const dir = fixtureDir()
    const deps = makeDeps(Buffer.alloc(0), '1.0.0')
    deps.downloadArchive.mockRejectedValue({ kind: 'rate_limited', message: 'slow' })

    const err = await installFromMarketplace(installOpts(deps, dir)).catch((e: unknown) => e)
    expect((err as { kind?: string }).kind).toBe('rate_limited')
  })

  it('rejects install when the downloaded archive fails checksum verification', async () => {
    const dir = fixtureDir()
    const deps = makeDeps(Buffer.alloc(0), '1.0.0')
    deps.downloadArchive.mockRejectedValue({ kind: 'checksum_mismatch', message: 'mismatch' })

    await expect(installFromMarketplace(installOpts(deps, dir))).rejects.toThrow(/校验/)
  })
})

describe('previewSkillMeta', () => {
  it('downloads and parses metadata without extracting or confirming', async () => {
    const dir = fixtureDir()
    const deps = makeDeps(makeTarGz(GOOD_FILES), '1.0.0')

    const meta = await previewSkillMeta(SESSION, 'demo', deps as never)

    expect(meta).toMatchObject({ name: 'demo', version: '1.0.0', author: 'ops', entrypoint: 'scripts/run.py' })
    expect(existsSync(join(dir, 'demo'))).toBe(false)
    expect(deps.downloadArchive).toHaveBeenCalledTimes(1)
  })
})

describe('removeSkill', () => {
  it('deletes the skill directory and drops the settings record', async () => {
    const dir = fixtureDir()
    const deps = makeDeps(makeTarGz(GOOD_FILES), '1.0.0')
    await installFromMarketplace(installOpts(deps, dir))

    removeSkill(dir, 'demo', deps as never)

    expect(existsSync(join(dir, 'demo'))).toBe(false)
    const installed = listInstalledSkills(deps.getSetting as never)
    expect(installed['demo']).toBeUndefined()
  })

  it('is a no-op for an unknown skill', () => {
    const dir = fixtureDir()
    const deps = makeDeps(makeTarGz(GOOD_FILES), '1.0.0')

    expect(() => removeSkill(dir, 'ghost', deps as never)).not.toThrow()
  })
})
