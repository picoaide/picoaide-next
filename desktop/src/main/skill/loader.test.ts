import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { isSafeSegment, load, parseMetadataYaml, SkillLoadError } from './loader'

const dirs: string[] = []

function fixtureDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'picoaide-skills-'))
  dirs.push(d)
  return d
}

function writeSkill(dir: string, name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, name, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

const SKILL_MD = '# docx\n\nConvert documents to docx.'
const METADATA = `name: docx
version: 1.2.0
author: ops
description: Word 文档转换
dependencies:
  - python3
  - libreoffice
entrypoint: scripts/run.py
`

describe('load', () => {
  it('returns instruction and entrypoint for a valid skill', () => {
    const dir = fixtureDir()
    writeSkill(dir, 'docx', { 'SKILL.md': SKILL_MD, 'metadata.yaml': METADATA, 'scripts/run.py': 'print(1)' })

    const s = load(dir, 'docx')

    expect(s.instruction).toBe(SKILL_MD)
    expect(s.entrypoint).toBe('scripts/run.py')
    expect(s.meta).toEqual({
      name: 'docx',
      version: '1.2.0',
      author: 'ops',
      description: 'Word 文档转换',
      dependencies: ['python3', 'libreoffice'],
      entrypoint: 'scripts/run.py',
    })
  })

  it('defaults entrypoint to scripts/run.sh when metadata omits it', () => {
    const dir = fixtureDir()
    writeSkill(dir, 'docx', { 'SKILL.md': SKILL_MD, 'metadata.yaml': 'name: docx\nversion: 1.0.0\n' })

    expect(load(dir, 'docx').entrypoint).toBe('scripts/run.sh')
  })

  it('throws when SKILL.md is missing', () => {
    const dir = fixtureDir()
    writeSkill(dir, 'docx', { 'metadata.yaml': METADATA })

    expect(() => load(dir, 'docx')).toThrow(SkillLoadError)
    expect(() => load(dir, 'docx')).toThrow(/SKILL\.md/)
  })

  it('throws when metadata.yaml is missing', () => {
    const dir = fixtureDir()
    writeSkill(dir, 'docx', { 'SKILL.md': SKILL_MD })

    expect(() => load(dir, 'docx')).toThrow(/metadata\.yaml/)
  })

  it('throws on missing version', () => {
    const dir = fixtureDir()
    writeSkill(dir, 'docx', { 'SKILL.md': SKILL_MD, 'metadata.yaml': 'name: docx\n' })

    expect(() => load(dir, 'docx')).toThrow(/版本/)
  })

  it('throws on non-semver version', () => {
    const dir = fixtureDir()
    writeSkill(dir, 'docx', { 'SKILL.md': SKILL_MD, 'metadata.yaml': 'name: docx\nversion: abc\n' })

    expect(() => load(dir, 'docx')).toThrow(/版本/)
  })

  it('throws on unsafe name', () => {
    const dir = fixtureDir()
    expect(() => load(dir, '../evil')).toThrow(/名称/)
    expect(() => load(dir, 'a/b')).toThrow(/名称/)
    expect(() => load(dir, '')).toThrow(/名称/)
  })
})

describe('isSafeSegment', () => {
  it('accepts plain names, rejects traversal/absolute/empty', () => {
    expect(isSafeSegment('docx')).toBe(true)
    expect(isSafeSegment('my-skill_2')).toBe(true)
    expect(isSafeSegment('')).toBe(false)
    expect(isSafeSegment('.')).toBe(false)
    expect(isSafeSegment('..')).toBe(false)
    expect(isSafeSegment('a/b')).toBe(false)
    expect(isSafeSegment('a\\b')).toBe(false)
    expect(isSafeSegment('/etc')).toBe(false)
  })
})

describe('parseMetadataYaml', () => {
  it('parses flat keys and dash arrays', () => {
    const m = parseMetadataYaml(METADATA)
    expect(m.name).toBe('docx')
    expect(m.version).toBe('1.2.0')
    expect(m.author).toBe('ops')
    expect(m.dependencies).toEqual(['python3', 'libreoffice'])
    expect(m.entrypoint).toBe('scripts/run.py')
  })

  it('ignores comments and blank lines', () => {
    const m = parseMetadataYaml('# comment\n\nname: demo\n')
    expect(m.name).toBe('demo')
  })
})
