import { describe, expect, it } from 'vitest'
import { composeUserContent, dataUrlBytes, imageExt, parseUserContent, validateImage } from './attachments'

describe('imageExt', () => {
  it('maps supported mime types to file extensions', () => {
    expect(imageExt('image/png')).toBe('png')
    expect(imageExt('image/jpeg')).toBe('jpg')
    expect(imageExt('image/webp')).toBe('webp')
    expect(imageExt('image/gif')).toBeNull()
    expect(imageExt('')).toBeNull()
  })
})

describe('validateImage', () => {
  it('accepts png/jpeg/webp under 5MB', () => {
    expect(validateImage('image/png', 1024)).toBeNull()
    expect(validateImage('image/jpeg', 5 * 1024 * 1024)).toBeNull()
  })

  it('rejects unsupported formats', () => {
    expect(validateImage('image/gif', 1024)).toContain('不支持')
    expect(validateImage('image/bmp', 1024)).toContain('不支持')
  })

  it('rejects images over 5MB', () => {
    expect(validateImage('image/png', 5 * 1024 * 1024 + 1)).toContain('5MB')
  })
})

describe('dataUrlBytes', () => {
  it('computes decoded byte length from base64 payload', () => {
    const b64 = Buffer.from('hello world').toString('base64')
    expect(dataUrlBytes(`data:text/plain;base64,${b64}`)).toBe(11)
  })

  it('handles padding and empty payloads', () => {
    expect(dataUrlBytes('data:image/png;base64,AQID')).toBe(3)
    expect(dataUrlBytes('data:image/png;base64,')).toBe(0)
    expect(dataUrlBytes('not-a-data-url')).toBe(0)
  })
})

describe('composeUserContent / parseUserContent', () => {
  it('composes markers above text and parses them back', () => {
    const content = composeUserContent('帮我看看这张图', {
      images: ['/ws/attachments/attach-1.png'],
      files: ['/ws/attachments/data.csv'],
    })
    expect(content).toBe('[图片: /ws/attachments/attach-1.png]\n[附带文件: /ws/attachments/data.csv]\n\n帮我看看这张图')
    const parsed = parseUserContent(content)
    expect(parsed).toEqual({
      text: '帮我看看这张图',
      images: ['/ws/attachments/attach-1.png'],
      files: ['/ws/attachments/data.csv'],
    })
  })

  it('keeps plain text unchanged (no markers)', () => {
    expect(parseUserContent('普通消息')).toEqual({ text: '普通消息', images: [], files: [] })
    expect(composeUserContent('普通消息', { images: [], files: [] })).toBe('普通消息')
  })

  it('parses image-only and file-only contents', () => {
    expect(parseUserContent('[图片: /a.png]\n\n正文')).toEqual({ text: '正文', images: ['/a.png'], files: [] })
    expect(parseUserContent('[附带文件: /b.txt]')).toEqual({ text: '', images: [], files: ['/b.txt'] })
  })
})
