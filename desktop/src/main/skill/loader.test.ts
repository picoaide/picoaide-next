import { describe, expect, it } from 'vitest'
import { isSafeSegment, parseMetadataYaml } from './loader'

const METADATA = `name: docx
version: 1.2.0
author: ops
description: Word 文档转换
dependencies:
  - python3
  - libreoffice
entrypoint: scripts/run.py
`

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
