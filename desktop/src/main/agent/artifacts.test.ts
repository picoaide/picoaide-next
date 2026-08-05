import { describe, expect, it } from 'vitest'
import { artifactType } from './artifacts'

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
