import fs from 'node:fs'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { Tool } from 'ai'
import iconv from 'iconv-lite'
import { isAllowed, ToolError } from './paths'

// 高危工具清单:引擎层审批门控识别(run({ tools, highRiskTools: new Set(HIGH_RISK_TOOLS) }))
export const HIGH_RISK_TOOLS: string[] = ['file_delete']

export interface FileToolContext {
  allowedDirs: string[]
  cwd: string
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size?: number
}

const MAX_SEARCH_RESULTS = 200

// 无法解析为文本的二进制扩展(其余未知扩展按文本探测处理)
const BINARY_EXTS = new Set([
  'xlsx', 'xls', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico',
  'zip', 'rar', '7z', 'gz', 'tar', 'jar', 'exe', 'dll', 'so', 'dylib', 'bin',
  'mp3', 'mp4', 'avi', 'mkv', 'doc', 'ppt', 'pptx', 'ttf', 'otf', 'woff', 'woff2',
])

function resolvePath(ctx: FileToolContext, p: string): string {
  const abs = path.resolve(ctx.cwd, p)
  if (!isAllowed(abs, ctx.allowedDirs)) throw new ToolError(`路径不在允许目录内: ${abs}`)
  return abs
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

function decodeBuffer(buf: Buffer, forced?: string): string {
  const enc = (forced ?? '').toLowerCase()
  if (enc === 'gbk' || enc === 'gb2312' || enc === 'gb18030' || enc === 'big5') {
    return iconv.decode(buf, enc === 'gbk' ? 'gbk' : enc)
  }
  if (enc && enc !== 'utf8' && enc !== 'utf-8') {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf)
    } catch {
      throw new ToolError(`不支持该编码: ${enc}`)
    }
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return iconv.decode(buf, 'gbk')
  }
}

// detectEncoding:与 decodeBuffer 同源判定,供编辑/追加时按原编码回写,
// 避免 GBK/UTF-16 文件被静默改成 UTF-8 造成乱码。
function detectEncoding(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return 'utf8'
  } catch {
    return 'gbk'
  }
}

// encodeForWrite:把编辑结果按源文件编码回写(含 BOM 还原)。
function encodeForWrite(text: string, enc: string): Buffer {
  switch (enc) {
    case 'utf8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')])
    case 'utf-16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf-16be': {
      const le = Buffer.from(text, 'utf16le')
      const be = Buffer.allocUnsafe(le.length)
      for (let i = 0; i + 1 < le.length; i += 2) {
        be[i] = le[i + 1]
        be[i + 1] = le[i]
      }
      return Buffer.concat([Buffer.from([0xfe, 0xff]), be])
    }
    case 'gbk':
      return iconv.encode(text, 'gbk')
    default:
      return Buffer.from(text, 'utf8')
  }
}

async function extractDocxText(buf: Buffer): Promise<string> {
  try {
    // 惰性加载:仅 .docx 时才引入 mammoth
    const mammoth = (await import('mammoth')) as unknown as {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>
    }
    const result = await mammoth.extractRawText({ buffer: buf })
    return result.value
  } catch (err) {
    throw new ToolError(`无法解析该 docx 文件: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function readTextFile(absPath: string, forced?: string): Promise<string> {
  const buf = fs.readFileSync(absPath)
  const ext = path.extname(absPath).toLowerCase()
  if (ext === '.docx') return extractDocxText(buf)
  if (BINARY_EXTS.has(ext.slice(1))) throw new ToolError(`不支持解析该格式: ${ext}`)
  return decodeBuffer(buf, forced)
}

export function createFileTools(ctx: FileToolContext): Record<string, Tool> {
  return {
    file_read: tool({
      description: '读取文本文件,自动检测编码(UTF-8/UTF-16 BOM/GBK);.docx 自动抽取纯文本;offset/limit 按行分页读大文件',
      inputSchema: z.object({
        path: z.string().describe('文件路径(相对 cwd 或绝对路径)'),
        encoding: z.string().optional().describe('强制编码,如 gbk/utf8;缺省自动检测'),
        offset: z.number().int().min(0).optional().describe('起始行号(0 起),缺省从头'),
        limit: z.number().int().min(1).max(5000).optional().describe('读取行数,缺省全部'),
      }),
      execute: async ({ path: p, encoding, offset, limit }) => {
        const text = await readTextFile(resolvePath(ctx, p), encoding)
        if (offset === undefined && limit === undefined) return text
        const lines = text.split('\n')
        const start = offset ?? 0
        const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit)
        return lines.slice(start, end).join('\n')
      },
    }),

    file_write: tool({
      description: '写入文件(覆盖);父目录不存在时自动创建',
      inputSchema: z.object({
        path: z.string().describe('文件路径(相对 cwd 或绝对路径)'),
        content: z.string(),
      }),
      execute: async ({ path: p, content }) => {
        const abs = resolvePath(ctx, p)
        // ponytail: 父目录自动创建(mkdir recursive),引擎层保证路径在允许目录内
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf8')
        return `已写入 ${abs}`
      },
    }),

    file_edit: tool({
      description: '编辑文件:将第一处出现的 oldText 替换为 newText',
      inputSchema: z.object({
        path: z.string().describe('文件路径(相对 cwd 或绝对路径)'),
        oldText: z.string(),
        newText: z.string(),
      }),
      execute: async ({ path: p, oldText, newText }) => {
        const abs = resolvePath(ctx, p)
        const buf = fs.readFileSync(abs)
        const enc = detectEncoding(buf)
        const text = decodeBuffer(buf)
        const idx = text.indexOf(oldText)
        if (idx === -1) throw new ToolError(`未找到要替换的内容: ${oldText.slice(0, 50)}`)
        const out = text.slice(0, idx) + newText + text.slice(idx + oldText.length)
        fs.writeFileSync(abs, encodeForWrite(out, enc))
        return `已替换 1 处`
      },
    }),

    file_append: tool({
      description: '向文件追加内容(文件不存在时创建)',
      inputSchema: z.object({
        path: z.string().describe('文件路径(相对 cwd 或绝对路径)'),
        content: z.string(),
      }),
      execute: async ({ path: p, content }) => {
        const abs = resolvePath(ctx, p)
        let enc = 'utf8'
        try {
          const detected = detectEncoding(fs.readFileSync(abs))
          enc = detected === 'utf8-bom' ? 'utf8' : detected // 追加不带 BOM 前缀
        } catch {
          enc = 'utf8' // 文件不存在:按 UTF-8 创建
        }
        fs.appendFileSync(abs, encodeForWrite(content, enc))
        return `已追加到 ${abs}`
      },
    }),

    file_delete: tool({
      description: '删除文件',
      inputSchema: z.object({
        path: z.string().describe('文件路径(相对 cwd 或绝对路径)'),
      }),
      execute: async ({ path: p }) => {
        const abs = resolvePath(ctx, p)
        fs.unlinkSync(abs)
        return `已删除 ${abs}`
      },
    }),

    file_list: tool({
      description: '列出目录内容(可选递归)',
      inputSchema: z.object({
        path: z.string().describe('目录路径(相对 cwd 或绝对路径)'),
        recursive: z.boolean().optional().describe('是否递归子目录,默认 false'),
      }),
      execute: async ({ path: p, recursive }) => {
        const abs = resolvePath(ctx, p)
        const out: FileEntry[] = []
        const stack: string[] = [abs]
        while (stack.length > 0) {
          const dir = stack.pop() as string
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name)
            const isDir = ent.isDirectory()
            if (isDir && recursive) stack.push(full)
            const entry: FileEntry = { name: ent.name, path: full, isDir }
            if (!isDir) entry.size = fs.statSync(full).size
            out.push(entry)
          }
        }
        return JSON.stringify(out)
      },
    }),

    file_search: tool({
      description: '搜索文件:按文件名子串(query)或文件内容(content,正则)匹配,大小写不敏感,递归,最多 200 条',
      inputSchema: z.object({
        query: z.string().optional().describe('文件名子串(与 content 二选一,可同时给:先按文件名过滤再按内容匹配)'),
        content: z.string().optional().describe('文件内容正则(chatbox search_files 语义;仅扫文本文件,单文件 ≤1MB)'),
        path: z.string().optional().describe('搜索起始目录(相对 cwd 或绝对路径),缺省为 cwd'),
        recursive: z.boolean().optional().describe('是否递归子目录,默认 true'),
      }),
      execute: async ({ query, content, path: p, recursive }) => {
        const abs = resolvePath(ctx, p ?? '')
        const q = (query ?? '').toLowerCase()
        let contentRe: RegExp | null = null
        if (content) {
          try {
            contentRe = new RegExp(content, 'i')
          } catch {
            throw new ToolError(`非法正则: ${content.slice(0, 50)}`)
          }
        }
        if (!q && !contentRe) throw new ToolError('请提供 query(文件名)或 content(内容)')
        const out: FileEntry[] = []
        const stack: string[] = [abs]
        const rec = recursive ?? true
        const MAX_FILE_BYTES = 1024 * 1024
        while (stack.length > 0 && out.length < MAX_SEARCH_RESULTS) {
          const dir = stack.pop() as string
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (out.length >= MAX_SEARCH_RESULTS) break
            const full = path.join(dir, ent.name)
            const isDir = ent.isDirectory()
            if (isDir && rec) stack.push(full)
            if (isDir) continue
            if (q && !ent.name.toLowerCase().includes(q)) continue
            if (contentRe) {
              const st = fs.statSync(full)
              if (st.size > MAX_FILE_BYTES) continue
              let text = ''
              try {
                text = fs.readFileSync(full, 'utf8')
              } catch {
                continue
              }
              if (!contentRe.test(text)) continue
            }
            const entry: FileEntry = { name: ent.name, path: full, isDir }
            entry.size = fs.statSync(full).size
            out.push(entry)
          }
        }
        return JSON.stringify(out)
      },
    }),
  }
}

export { isAllowed, ToolError } from './paths'
