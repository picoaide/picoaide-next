import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageFileToDataUrl, userContentParts } from './attachments'

function makePng(): string {
  const dir = mkdtempSync(join(tmpdir(), 'attach-'))
  const path = join(dir, 'shot.png')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
  return path
}

describe('imageFileToDataUrl', () => {
  it('reads a png file into a dataUrl', () => {
    const path = makePng()
    try {
      expect(imageFileToDataUrl(path)).toMatch(/^data:image\/png;base64,/)
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('returns null for unsupported extensions and missing files', () => {
    expect(imageFileToDataUrl('/tmp/nonexistent.png')).toBeNull()
    expect(imageFileToDataUrl('/tmp/notes.txt')).toBeNull()
  })
})

describe('userContentParts', () => {
  it('returns plain string when content has no image refs', () => {
    expect(userContentParts('hello')).toBe('hello')
    expect(userContentParts('[附带文件: /x.csv]')).toBe('[附带文件: /x.csv]')
  })

  it('converts image refs into image parts and keeps text as text part', () => {
    const path = makePng()
    try {
      const parts = userContentParts(`[图片: ${path}]\n\n描述这个截图`) as Array<{
        type: string
        text?: string
        image?: string
      }>
      expect(parts).toHaveLength(2)
      expect(parts[0]).toMatchObject({ type: 'text', text: '描述这个截图' })
      expect(parts[1].type).toBe('image')
      expect(parts[1].image).toMatch(/^data:image\/png;base64,/)
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('annotates file refs for the model to read with tools', () => {
    const path = makePng()
    try {
      const parts = userContentParts(`[图片: ${path}]\n[附带文件: /ws/data.csv]`) as Array<{
        type: string
        text?: string
      }>
      const text = parts.find((p) => p.type === 'text')?.text ?? ''
      expect(text).toContain('[附带文件: /ws/data.csv](请用文件读取工具查看)')
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('falls back to plain text when every image file is unreadable', () => {
    expect(userContentParts('[图片: /gone/away.png]\n\n还有文字')).toBe(
      '[图片: /gone/away.png]\n\n还有文字',
    )
  })

  it('sends only image parts when text is empty', () => {
    const path = makePng()
    try {
      const parts = userContentParts(`[图片: ${path}]`) as Array<{ type: string }>
      expect(parts).toHaveLength(1)
      expect(parts[0].type).toBe('image')
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })
})
