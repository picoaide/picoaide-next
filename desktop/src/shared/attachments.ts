// 附带文件契约(renderer 与 main 共享的纯逻辑):粘贴图片/拖拽文件的校验、
// base64 dataUrl 工具、以及 user 消息内容中图片/文件引用的组合与解析。
// 内容格式:DB 只存文本引用(不存 base64),模型侧由 engine 恢复为图片 part。

export type AttachmentKind = 'image' | 'file'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export interface AttachmentInput {
  kind: AttachmentKind
  name: string
  dataUrl: string
}

export interface AttachResult {
  kind: AttachmentKind
  name: string
  path: string
}

export function imageExt(mime: string): string | null {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    default:
      return null
  }
}

export function validateImage(mime: string, bytes: number): string | null {
  if (!IMAGE_MIME_TYPES.includes(mime as (typeof IMAGE_MIME_TYPES)[number])) {
    return '不支持的图片格式,仅支持 PNG/JPEG/WebP'
  }
  if (bytes > MAX_IMAGE_BYTES) {
    return '图片超过 5MB 大小限制'
  }
  return null
}

export function dataUrlBytes(dataUrl: string): number {
  const idx = dataUrl.indexOf(',')
  if (idx === -1) return 0
  const b64 = dataUrl.slice(idx + 1)
  const raw = (b64.length * 3) / 4
  return Math.floor(raw) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
}

export function composeUserContent(text: string, refs: { images: string[]; files: string[] }): string {
  const markers = [
    ...refs.images.map((p) => `[图片: ${p}]`),
    ...refs.files.map((p) => `[附带文件: ${p}]`),
  ]
  const body = text.trim()
  if (markers.length === 0) return body
  return markers.join('\n') + (body ? `\n\n${body}` : '')
}

export function parseUserContent(content: string): { text: string; images: string[]; files: string[] } {
  const images: string[] = []
  const files: string[] = []
  const text = content
    .replace(/\[图片: ([^\]]+)\]/g, (_m, p: string) => {
      images.push(p)
      return ''
    })
    .replace(/\[附带文件: ([^\]]+)\]/g, (_m, p: string) => {
      files.push(p)
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, images, files }
}
