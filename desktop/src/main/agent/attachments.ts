import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { parseUserContent } from '../../shared/attachments'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

// 读本地图片文件为 dataUrl(重放/当前消息共用);不支持的类型或读失败 → null
export function imageFileToDataUrl(path: string): string | null {
  try {
    const mime = MIME_BY_EXT[extname(path).toLowerCase()]
    if (!mime) return null
    const buf = readFileSync(path)
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

// user 消息内容 → 模型内容:图片引用读文件转为 image part(dataUrl);
// 附带文件保留文本引用,提示模型用文件读取工具查看(不随多模态发送)。
// 无图片引用 → 原样字符串;图片全部读取失败 → 降级为纯文本引用(不丢信息、不崩溃)。
export function userContentParts(
  content: string,
): string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> {
  const { text, images, files } = parseUserContent(content)
  if (images.length === 0) return content
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = []
  const failed: string[] = []
  for (const p of images) {
    const dataUrl = imageFileToDataUrl(p)
    if (dataUrl) parts.push({ type: 'image', image: dataUrl })
    else failed.push(`[图片: ${p}]`)
  }
  const body = [...failed, text, ...files.map((f) => `[附带文件: ${f}](请用文件读取工具查看)`)]
    .filter(Boolean)
    .join('\n\n')
  if (parts.length === 0) return body
  if (body) parts.unshift({ type: 'text', text: body })
  return parts
}
