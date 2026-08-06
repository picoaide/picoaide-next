import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('rejects paths outside the workspace attachments dir (replay boundary)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'attach-ws-'))
    try {
      expect(imageFileToDataUrl('/etc/hosts', { workspace: ws })).toBeNull()
      expect(imageFileToDataUrl(join(ws, 'outside.png'), { workspace: ws })).toBeNull()
      expect(imageFileToDataUrl(join(ws, 'attachments2', 'x.png'), { workspace: ws })).toBeNull()
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('rejects attachments larger than 5MB', () => {
    const ws = mkdtempSync(join(tmpdir(), 'attach-ws-'))
    try {
      const dir = join(ws, 'attachments')
      mkdirSync(dir, { recursive: true })
      const big = join(dir, 'big.png')
      writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0x89))
      expect(imageFileToDataUrl(big, { workspace: ws })).toBeNull()
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('accepts images inside the workspace attachments dir', () => {
    const ws = mkdtempSync(join(tmpdir(), 'attach-ws-'))
    try {
      const dir = join(ws, 'attachments')
      mkdirSync(dir, { recursive: true })
      const shot = join(dir, 'shot.png')
      writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
      expect(imageFileToDataUrl(shot, { workspace: ws })).toMatch(/^data:image\/png;base64,/)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
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

  it('drops image refs outside the workspace attachments dir (no arbitrary path read)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'attach-ws-'))
    try {
      const parts = userContentParts('[图片: /etc/hosts]\n\n描述一下', { workspace: ws }) as string | Array<{ type: string }>
      // 越界引用不读文件:降级为纯文本引用
      expect(typeof parts).toBe('string')
      expect(parts).toContain('[图片: /etc/hosts]')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
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
