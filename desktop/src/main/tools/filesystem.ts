import fs from 'node:fs'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { Tool } from 'ai'
import iconv from 'iconv-lite'
import { inflateRawSync } from 'node:zlib'
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
// 整文件读入上限(readTextFile 与 edit/append 共用):超限拒绝,防数 GB 文件 OOM 主进程
const MAX_READ_BYTES = 20 * 1024 * 1024
// 目录遍历深度上限(递归 list/search):过深树(如 node_modules)同步遍历会冻结主进程
const MAX_LIST_DEPTH = 8

// 统一文件操作错误:原始 ENOENT/EACCES 直传模型不友好,包中文说明并保留 errno code
function wrapFsError(op: string, p: string, err: unknown): never {
  if (err instanceof ToolError) throw err
  const e = err as NodeJS.ErrnoException
  const code = e?.code ?? ''
  const msg =
    {
      ENOENT: `文件或目录不存在: ${p}`,
      EACCES: `无权限访问: ${p}`,
      EPERM: `无权限访问: ${p}`,
      EISDIR: `目标是目录,请指定文件: ${p}`,
      ENOTDIR: `路径中的目录不存在: ${p}`,
      ENAMETOOLONG: `路径过长: ${p}`,
    }[code] ?? `文件操作失败(${op}): ${p}`
  throw new ToolError(`${msg}${code ? ` [${code}]` : ''}`)
}

function fsOp<T>(op: string, p: string, fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    wrapFsError(op, p, err)
  }
}

// 无法解析为文本的二进制扩展(其余未知扩展按文本探测处理)
const BINARY_EXTS = new Set([
  'xlsx', 'xls', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico',
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
  const st = fsOp('read', absPath, () => fs.statSync(absPath))
  if (st.size > MAX_READ_BYTES) {
    throw new ToolError(`文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB),超过 ${MAX_READ_BYTES / 1024 / 1024}MB 读取上限`)
  }
  const buf = fsOp('read', absPath, () => fs.readFileSync(absPath))
  const ext = path.extname(absPath).toLowerCase()
  if (ext === '.docx') return extractDocxText(buf)
  if (ext === '.pdf' || isPdfMagic(buf)) return extractPdfText(buf)
  if (BINARY_EXTS.has(ext.slice(1))) throw new ToolError(`不支持解析该格式: ${ext}`)
  return decodeBuffer(buf, forced)
}


function isPdfMagic(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 // %PDF
}

// PDF 纯文本提取(零依赖):扫 stream..endstream,FlateDecode 解压,提取 BT..ET 内 Tj/TJ/十六进制串。
// 扫描件(无文本层)/格式异常 → 返回明确提示而非崩溃;常规办公 PDF(Word/PPT 导出)可正常提取。
function extractPdfText(buf: Buffer): string {
  const raw = buf.toString('latin1')
  const streams: Buffer[] = []
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m: RegExpExecArray | null
  while ((m = streamRe.exec(raw)) !== null) {
    streams.push(Buffer.from(m[1], 'latin1'))
  }
  if (streams.length === 0) return '无法提取文本: 未找到内容流(可能为扫描件或损坏文件)'
  const pages: string[] = []
  for (const s of streams) {
    // zip-bomb 防护:压缩流体积/解压后体积超限即跳过该流(恶意 PDF 可把 GB 数据压进小流)
    if (s.length > 5 * 1024 * 1024) continue
    let data: Buffer
    try {
      data = inflateRawSync(s, { maxOutputLength: 20 * 1024 * 1024 })
    } catch {
      data = s // 未压缩流
    }
    const text = extractTextOperators(data.toString('latin1'))
    if (text) pages.push(text)
  }
  if (pages.length === 0) return '无法提取文本: 内容流中未找到可解码文本(可能为扫描件)'
  return pages.join('\n\n')
}

function extractTextOperators(content: string): string {
  const out: string[] = []
  const opRe = /(?:\(((?:[^()\\]|\\.)*)\)|\[([^\]]*)\]|<([0-9a-fA-F\s]+)>)\s*(?:Tj|'|TJ)/g
  let m: RegExpExecArray | null
  while ((m = opRe.exec(content)) !== null) {
    if (m[1] !== undefined) out.push(decodePdfString(m[1]))
    else if (m[2] !== undefined) {
      const inner = /\(((?:[^()\\]|\\.)*)\)/g
      let im: RegExpExecArray | null
      while ((im = inner.exec(m[2])) !== null) out.push(decodePdfString(im[1]))
    } else if (m[3] !== undefined) out.push(decodePdfHex(m[3]))
  }
  return out.join('')
}

function decodePdfString(raw: string): string {
  return raw.replace(/\\([nrtbf()\\])/g, (_s, c: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c)
}

function decodePdfHex(hex: string): string {
  const clean = hex.replace(/\s+/g, '')
  if (clean.length % 2 !== 0) return ''
  const bytes = Buffer.from(clean, 'hex')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2).swap16().toString('utf16le') // UTF-16BE → LE → string
  }
  return bytes.toString('utf8')
}

// ReDoS 防护:嵌套量词((a+)+、(a{2,})* 等)在 1MB 内容上灾难性回溯会冻结主进程。
// 同步主线程无法限时中断正则 → 检测到嵌套量词直接拒绝,让模型改用简单字面量/正则
const NESTED_QUANTIFIER_RE = /\([^()]*[+*{][^()]*\)[+*{]/
// 无正则元字符的 content → 纯字面量子串匹配,不经过 RegExp(彻底绕开回溯面)
const REGEX_METACHAR_RE = /[.^$*+?\\[\]{}|]/

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
        fsOp('write', abs, () => fs.mkdirSync(path.dirname(abs), { recursive: true }))
        fsOp('write', abs, () => fs.writeFileSync(abs, content, 'utf8'))
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
        // 大文件上限与 file_read 同口径:整文件读入,数 GB 日志不能 OOM 主进程
        const st = fsOp('edit', abs, () => fs.statSync(abs))
        if (st.size > MAX_READ_BYTES) {
          throw new ToolError(`文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB),超过 ${MAX_READ_BYTES / 1024 / 1024}MB 编辑上限`)
        }
        const buf = fsOp('edit', abs, () => fs.readFileSync(abs))
        const enc = detectEncoding(buf)
        const text = decodeBuffer(buf)
        const idx = text.indexOf(oldText)
        if (idx === -1) throw new ToolError(`未找到要替换的内容: ${oldText.slice(0, 50)}`)
        const out = text.slice(0, idx) + newText + text.slice(idx + oldText.length)
        fsOp('edit', abs, () => fs.writeFileSync(abs, encodeForWrite(out, enc)))
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
          // 大文件上限同 file_read:编码探测需整文件读入,超限拒绝(超大日志请用终端)
          const st = fs.statSync(abs)
          if (st.size > MAX_READ_BYTES) {
            throw new ToolError(`文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB),超过 ${MAX_READ_BYTES / 1024 / 1024}MB 追加上限`)
          }
          const detected = detectEncoding(fs.readFileSync(abs))
          enc = detected === 'utf8-bom' ? 'utf8' : detected // 追加不带 BOM 前缀
        } catch (err) {
          if (err instanceof ToolError) throw err
          enc = 'utf8' // 文件不存在:按 UTF-8 创建
        }
        fsOp('append', abs, () => fs.appendFileSync(abs, encodeForWrite(content, enc)))
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
        fsOp('delete', abs, () => fs.unlinkSync(abs))
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
        // 深度带进栈:同步遍历过深树(node_modules)会冻结主进程,深度/条数双上限
        const stack: Array<{ dir: string; depth: number }> = [{ dir: abs, depth: 0 }]
        while (stack.length > 0) {
          const { dir, depth } = stack.pop() as { dir: string; depth: number }
          let entries
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch (err) {
            if (dir === abs) wrapFsError('list', dir, err) // 起始目录缺失/无权限:报中文错误
            continue // 子目录无权限/已删除:跳过,不影响其余条目
          }
          for (const ent of entries) {
            if (out.length >= MAX_SEARCH_RESULTS) break
            const full = path.join(dir, ent.name)
            const isDir = ent.isDirectory()
            if (isDir && recursive && depth < MAX_LIST_DEPTH - 1) stack.push({ dir: full, depth: depth + 1 })
            const entry: FileEntry = { name: ent.name, path: full, isDir }
            if (!isDir) {
              try {
                entry.size = fs.statSync(full).size
              } catch {
                continue // 损坏/悬空 symlink:跳过该条目
              }
            }
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
        let literal: string | null = null
        if (content) {
          if (content.length > 200) throw new ToolError('content 正则过长(>200 字符),请缩短')
          if (NESTED_QUANTIFIER_RE.test(content)) {
            // ReDoS 防护:LLM 提供的正则可能灾难性回溯((a+)+$),同步主进程会冻结 UI
            throw new ToolError('content 含嵌套量词(如 (a+)+),有回溯攻击风险,请改用简单正则或字面量')
          }
          if (REGEX_METACHAR_RE.test(content)) {
            try {
              contentRe = new RegExp(content, 'i')
            } catch {
              throw new ToolError(`非法正则: ${content.slice(0, 50)}`)
            }
          } else {
            literal = content.toLowerCase()
          }
        }
        if (!q && !contentRe && !literal) throw new ToolError('请提供 query(文件名)或 content(内容)')
        const out: FileEntry[] = []
        const stack: Array<{ dir: string; depth: number }> = [{ dir: abs, depth: 0 }]
        const rec = recursive ?? true
        const MAX_FILE_BYTES = 1024 * 1024
        while (stack.length > 0 && out.length < MAX_SEARCH_RESULTS) {
          const { dir, depth } = stack.pop() as { dir: string; depth: number }
          let entries
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch (err) {
            if (dir === abs) wrapFsError('search', dir, err) // 起始目录缺失/无权限:报中文错误
            continue // 子目录无权限/已删除:跳过
          }
          for (const ent of entries) {
            if (out.length >= MAX_SEARCH_RESULTS) break
            const full = path.join(dir, ent.name)
            const isDir = ent.isDirectory()
            if (isDir && rec && depth < MAX_LIST_DEPTH - 1) stack.push({ dir: full, depth: depth + 1 })
            if (isDir) continue
            if (q && !ent.name.toLowerCase().includes(q)) continue
            if (contentRe || literal) {
              let st
              try {
                st = fs.statSync(full)
              } catch {
                continue // 损坏/悬空 symlink:跳过
              }
              if (st.size > MAX_FILE_BYTES) continue
              let text = ''
              try {
                text = fs.readFileSync(full, 'utf8')
              } catch {
                continue
              }
              if (contentRe && !contentRe.test(text)) continue
              if (literal && !text.toLowerCase().includes(literal)) continue
            }
            const entry: FileEntry = { name: ent.name, path: full, isDir }
            try {
              entry.size = fs.statSync(full).size
            } catch {
              continue
            }
            out.push(entry)
          }
        }
        return JSON.stringify(out)
      },
    }),
  }
}
