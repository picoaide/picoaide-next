import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseUserContent } from '../../shared/attachments'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

// 图片附件大小上限:重放超大 base64 会撑爆模型上下文/内存
const MAX_ATTACH_BYTES = 5 * 1024 * 1024

// 读本地图片文件为 dataUrl(重放/当前消息共用);不支持的类型或读失败 → null。
// 会话重放必须限定在 workspace/attachments 内:DB 里被篡改的 [图片: /etc/...] 引用
// 不得读任意路径(越界路径/超大文件一律拒绝)
export function imageFileToDataUrl(path: string, opts: { workspace?: string } = {}): string | null {
  try {
    const mime = MIME_BY_EXT[extname(path).toLowerCase()]
    if (!mime) return null
    if (!isAbsolute(path)) return null
    if (opts.workspace) {
      const attachmentsDir = join(resolve(opts.workspace), 'attachments') + sep
      if (!resolve(path).startsWith(attachmentsDir)) return null
    }
    if (statSync(path).size > MAX_ATTACH_BYTES) return null
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
  opts: { workspace?: string } = {},
): string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> {
  const { text, images, files } = parseUserContent(content)
  if (images.length === 0) return content
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = []
  const failed: string[] = []
  for (const p of images) {
    const dataUrl = imageFileToDataUrl(p, opts)
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
