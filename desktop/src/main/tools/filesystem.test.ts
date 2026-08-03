import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { deflateRawSync } from 'node:zlib'
import { createFileTools, HIGH_RISK_TOOLS } from './filesystem'
import type { FileToolContext } from './filesystem'

const dirs: string[] = []

function makeCtx(): { ctx: FileToolContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'))
  dirs.push(dir)
  return { ctx: { allowedDirs: [dir], cwd: dir }, dir }
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

// Tool.execute 在 AI SDK v7 中签名较窄(且可选);测试直接调 execute 即可
function exec(tool: any, input: unknown): Promise<unknown> {
  return tool.execute(input, {})
}

// ---- 最小 ZIP 写入器(node 无内置 zip;测试内手工构造,仅用于 docx fixture) ----

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const deflated = deflateRawSync(data)
    const crc = crc32(data)

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0, 6)
    lfh.writeUInt16LE(8, 8)
    lfh.writeUInt16LE(0, 10)
    lfh.writeUInt16LE(0, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(deflated.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    parts.push(lfh, nameBuf, deflated)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(deflated.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))

    offset += lfh.length + nameBuf.length + deflated.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, cdBuf, eocd])
}

const DOCX_XML = {
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>',
  'word/document.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>Hello 中文 docx</w:t></w:r></w:p></w:body></w:document>',
}

describe('file_read', () => {
  it('reads a UTF-8 file', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello 中文\nworld')
    const tools = createFileTools(ctx)
    const out = await exec(tools.file_read, { path: 'a.txt' })
    expect(out).toBe('hello 中文\nworld')
  })

  it('auto-decodes a GBK file', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'gbk.txt'), iconv.encode('中文GBK测试', 'gbk'))
    const tools = createFileTools(ctx)
    expect(await exec(tools.file_read, { path: 'gbk.txt' })).toBe('中文GBK测试')
  })

  it('decodes UTF-16 with BOM', async () => {
    const { ctx, dir } = makeCtx()
    const body = Buffer.from('中文utf16', 'utf16le')
    fs.writeFileSync(path.join(dir, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), body]))
    const tools = createFileTools(ctx)
    expect(await exec(tools.file_read, { path: 'u16.txt' })).toBe('中文utf16')
  })

  it('extracts plain text from a .docx file', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'report.docx'), buildZip(DOCX_XML))
    const tools = createFileTools(ctx)
    const out = await exec(tools.file_read, { path: 'report.docx' })
    expect(String(out)).toContain('Hello 中文')
  })

  it('rejects other binary formats with a clear error', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'data.xlsx'), Buffer.from('not really xlsx'))
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_read, { path: 'data.xlsx' })).rejects.toThrow('不支持解析该格式')
  })

  it('honors an explicit encoding override', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'e.txt'), 'override test')
    const tools = createFileTools(ctx)
    expect(await exec(tools.file_read, { path: 'e.txt', encoding: 'utf8' })).toBe('override test')
  })

  it('reads a line window with offset/limit (分页读,chatbox read_file 语义)', async () => {
    const { ctx, dir } = makeCtx()
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`)
    fs.writeFileSync(path.join(dir, 'big.txt'), lines.join('\n'))
    const tools = createFileTools(ctx)
    const out = await exec(tools.file_read, { path: 'big.txt', offset: 3, limit: 4 })
    expect(out).toBe(['line3', 'line4', 'line5', 'line6'].join('\n'))
  })

  it('rejects an out-of-boundary path', async () => {
    const { ctx } = makeCtx()
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_read, { path: '/etc/passwd' })).rejects.toThrow('路径不在允许目录内')
    await expect(exec(tools.file_read, { path: '../evil.txt' })).rejects.toThrow('路径不在允许目录内')
  })
})

describe('file_write', () => {
  it('writes content and auto-creates parent dirs', async () => {
    const { ctx, dir } = makeCtx()
    const tools = createFileTools(ctx)
    await exec(tools.file_write, { path: 'sub/nested/b.txt', content: '内容' })
    expect(fs.readFileSync(path.join(dir, 'sub', 'nested', 'b.txt'), 'utf8')).toBe('内容')
  })

  it('rejects an out-of-boundary path', async () => {
    const { ctx } = makeCtx()
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_write, { path: '../evil.txt', content: 'x' })).rejects.toThrow('路径不在允许目录内')
  })
})

describe('file_edit', () => {
  it('replaces only the first occurrence', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'e.txt'), 'aa bb aa', 'utf8')
    const tools = createFileTools(ctx)
    await exec(tools.file_edit, { path: 'e.txt', oldText: 'aa', newText: 'xx' })
    expect(fs.readFileSync(path.join(dir, 'e.txt'), 'utf8')).toBe('xx bb aa')
  })

  it('errors when oldText is not found', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'e.txt'), 'nothing here', 'utf8')
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_edit, { path: 'e.txt', oldText: 'missing', newText: 'x' })).rejects.toThrow(
      '未找到',
    )
  })

  it('writes back a GBK file in GBK (no mojibake corruption)', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'gbk.txt'), iconv.encode('中文测试', 'gbk'))
    const tools = createFileTools(ctx)
    await exec(tools.file_edit, { path: 'gbk.txt', oldText: '测试', newText: '编辑' })
    const raw = fs.readFileSync(path.join(dir, 'gbk.txt'))
    expect(iconv.decode(raw, 'gbk')).toBe('中文编辑')
    // 字节仍是 GBK:按 UTF-8 严格解码必然失败
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(raw)).toThrow()
  })

  it('rejects an out-of-boundary path', async () => {
    const { ctx } = makeCtx()
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_edit, { path: '/etc/passwd', oldText: 'a', newText: 'b' })).rejects.toThrow(
      '路径不在允许目录内',
    )
  })
})

describe('file_append', () => {
  it('appends to an existing file', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'head', 'utf8')
    const tools = createFileTools(ctx)
    await exec(tools.file_append, { path: 'a.txt', content: '+tail' })
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('head+tail')
  })
})

describe('file_delete', () => {
  it('deletes an existing file', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'd.txt'), 'x', 'utf8')
    const tools = createFileTools(ctx)
    await exec(tools.file_delete, { path: 'd.txt' })
    expect(fs.existsSync(path.join(dir, 'd.txt'))).toBe(false)
  })

  it('errors when the file does not exist', async () => {
    const { ctx } = makeCtx()
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_delete, { path: 'missing.txt' })).rejects.toThrow()
  })

  it('rejects an out-of-boundary path', async () => {
    const { ctx } = makeCtx()
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_delete, { path: '/tmp' })).rejects.toThrow('路径不在允许目录内')
  })
})

describe('file_list', () => {
  const tree = (dir: string): void => {
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
    fs.writeFileSync(path.join(dir, 'c.txt'), 'cc')
  }

  it('lists recursively with name/path/isDir/size', async () => {
    const { ctx, dir } = makeCtx()
    tree(dir)
    const tools = createFileTools(ctx)
    const out = JSON.parse(String(await exec(tools.file_list, { path: '.', recursive: true }))) as Array<{
      name: string
      path: string
      isDir: boolean
      size?: number
    }>
    expect(out.length).toBe(4)
    const b = out.find((e) => e.name === 'b.txt')
    expect(b).toMatchObject({ isDir: false })
    expect(b?.size).toBe(1)
    expect(out.find((e) => e.name === 'sub')?.isDir).toBe(true)
    expect(out.find((e) => e.name === 'sub')?.size).toBeUndefined()
  })

  it('lists only top-level when not recursive', async () => {
    const { ctx, dir } = makeCtx()
    tree(dir)
    const tools = createFileTools(ctx)
    const out = JSON.parse(String(await exec(tools.file_list, { path: '.', recursive: false }))) as Array<{
      name: string
    }>
    expect(out.map((e) => e.name).sort()).toEqual(['a.txt', 'c.txt', 'sub'])
  })

  it('rejects an out-of-boundary path', async () => {
    const { ctx } = makeCtx()
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_list, { path: '/etc', recursive: true })).rejects.toThrow('路径不在允许目录内')
  })
})

describe('file_search', () => {
  it('matches filename substrings case-insensitively, recursive by default', async () => {
    const { ctx, dir } = makeCtx()
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'REPORT-2024.xlsx'), 'x')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    const tools = createFileTools(ctx)
    const out = JSON.parse(String(await exec(tools.file_search, { query: 'report' }))) as Array<{ name: string }>
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('REPORT-2024.xlsx')
  })

  it('bounds results at 200', async () => {
    const { ctx, dir } = makeCtx()
    for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(dir, `match-${i}.txt`), 'x')
    const tools = createFileTools(ctx)
    const out = JSON.parse(String(await exec(tools.file_search, { query: 'match' }))) as Array<{ name: string }>
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.every((e) => e.name.includes('match'))).toBe(true)
  })

  it('content search matches text inside files (search_files 语义)', async () => {
    const { ctx, dir } = makeCtx()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world')
    fs.writeFileSync(path.join(dir, 'b.md'), 'nothing here')
    const tools = createFileTools(ctx)
    const out = JSON.parse(String(await exec(tools.file_search, { content: 'world' }))) as Array<{ name: string }>
    expect(out.map((e) => e.name)).toEqual(['a.txt'])
  })

  it('rejects an out-of-boundary path', async () => {
    const { ctx } = makeCtx()
    const tools = createFileTools(ctx)
    await expect(exec(tools.file_search, { query: 'x', path: '/etc' })).rejects.toThrow('路径不在允许目录内')
  })
})

describe('high-risk registration', () => {
  it('marks file_delete as the only high-risk file tool', () => {
    expect(HIGH_RISK_TOOLS).toEqual(['file_delete'])
  })
})
