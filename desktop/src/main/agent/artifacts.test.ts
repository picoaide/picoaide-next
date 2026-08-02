import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { artifactType, createWorkspaceDir } from './artifacts'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('artifactType', () => {
  it('maps known extensions to artifact types', () => {
    expect(artifactType('/w/report.md')).toBe('report')
    expect(artifactType('/w/pic.png')).toBe('image')
    expect(artifactType('/w/pic.JPG')).toBe('image')
    expect(artifactType('/w/page.html')).toBe('html')
    expect(artifactType('/w/deck.pptx')).toBe('ppt')
    expect(artifactType('/w/doc.docx')).toBe('docx')
    expect(artifactType('/w/sheet.xlsx')).toBe('xlsx')
    expect(artifactType('/w/notes.txt')).toBe('file')
  })

  it('falls back to file for unknown or missing extensions', () => {
    expect(artifactType('/w/archive.tar.gz')).toBe('file')
    expect(artifactType('/w/noext')).toBe('file')
    expect(artifactType('')).toBe('file')
  })
})

describe('createWorkspaceDir', () => {
  it('creates a per-conversation directory and returns its path', () => {
    const root = mkdtempSync(join(tmpdir(), 'picoaide-ws-'))
    dirs.push(root)
    const dir = createWorkspaceDir(root, 42)
    expect(dir).toBe(join(root, '42'))
    expect(existsSync(dir)).toBe(true)
    // 幂等:重复调用不报错、路径不变
    expect(createWorkspaceDir(root, 42)).toBe(dir)
  })
})
