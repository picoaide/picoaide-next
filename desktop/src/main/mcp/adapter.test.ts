import { describe, expect, it, vi } from 'vitest'
import { formatMcpResult, inputSchemaToZod, isHighRiskTool, toAiSdkTool } from './adapter'

describe('isHighRiskTool (启发式动词表, best-effort 减噪,非安全边界)', () => {
  const cases: [string, string | undefined, boolean][] = [
    ['delete_record', undefined, true],
    ['remove_item', undefined, true],
    ['write_file', undefined, true],
    ['exec_command', undefined, true],
    ['shell_run', undefined, true],
    ['http_request', undefined, true],
    ['post_message', undefined, true],
    ['purge_cache', undefined, true],
    ['sync_now', undefined, true],
    ['truncate_log', undefined, true],
    ['unlink_old', undefined, true],
    ['rm', undefined, true],
    ['send_email', undefined, true], // 名称含 send
    ['upload_photo', undefined, true], // 名称含 upload
    ['post_status', undefined, true], // 名称含 post
    ['run', 'Executes a shell command', true], // 描述命中 shell
    ['read_record', undefined, false],
    ['list_records', undefined, false],
    ['get_page', 'Fetch a webpage and return text', false],
    ['mock_echo', '回显输入', false],
  ]
  for (const [name, description, expected] of cases) {
    it(`${name}${description ? ` (${description})` : ''} → ${expected ? '高危' : '非高危'}`, () => {
      expect(isHighRiskTool(name, description)).toBe(expected)
    })
  }
})

describe('inputSchemaToZod', () => {
  const parse = (schema: ReturnType<typeof inputSchemaToZod>) => (v: unknown) =>
    schema.parse(v) as Record<string, unknown>

  it('converts string/number/integer/boolean/array/object', () => {
    const schema = inputSchemaToZod({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        ratio: { type: 'number' },
        cache: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { a: { type: 'string' } } },
      },
      required: ['query', 'limit'],
    })
    const p = parse(schema)
    expect(p({ query: 'x', limit: 3 })).toEqual({ query: 'x', limit: 3 })
    expect(p({ query: 'x', limit: 3, ratio: 0.5, cache: true, tags: ['a'], nested: { a: 'b' } }).tags).toEqual(['a'])
    // 必填校验
    expect(() => schema.parse({ limit: 3 })).toThrow()
    expect(() => schema.parse({ query: 'x', limit: 'not-a-number' })).toThrow()
    // 非必填字段可省略
    expect(p({ query: 'x', limit: 1 }).cache).toBeUndefined()
  })

  it('respects enum and null', () => {
    const schema = inputSchemaToZod({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['a', 'b'] },
        maybe: { type: 'null' },
      },
    })
    expect(parse(schema)({ mode: 'a', maybe: null })).toEqual({ mode: 'a', maybe: null })
    expect(() => schema.parse({ mode: 'c' })).toThrow()
  })

  it('falls back to unknown for unsupported types', () => {
    const schema = inputSchemaToZod({
      type: 'object',
      properties: { weird: { type: 'object', format: 'file-binary' } },
    })
    const out = parse(schema)({ weird: { anything: [1, 2] } })
    expect(out.weird).toEqual({ anything: [1, 2] })
  })

  it('accepts an empty schema', () => {
    expect(inputSchemaToZod({ type: 'object', properties: {} }).parse({})).toEqual({})
  })
})

describe('toAiSdkTool', () => {
  it('wraps callTool and formats text content', async () => {
    const callTool = async () => ({ content: [{ type: 'text', text: 'hello:1' }] })
    const tool = toAiSdkTool(
      {
        name: 'mock_echo',
        description: '回显',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      callTool,
    )

    expect(tool.description).toBe('回显')
    const out = await tool.execute!({ text: 'hi' }, { toolCallId: 'c1' } as never)
    expect(out).toBe('hello:1')
  })

  it('throws when the plugin reports an error result', async () => {
    const callTool = async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true })
    const tool = toAiSdkTool({ name: 't', description: '', inputSchema: { type: 'object' } }, callTool)

    await expect(tool.execute!({}, { toolCallId: 'c1' } as never)).rejects.toThrow('boom')
  })

  it('passes the MCP tool name and raw args to callTool', async () => {
    const callTool = vi.fn(async () => ({ content: [] }))
    const tool = toAiSdkTool({ name: 't', description: '', inputSchema: { type: 'object' } }, callTool)

    await tool.execute!({ a: 1 }, { toolCallId: 'c1' } as never)
    expect(callTool).toHaveBeenCalledWith('t', { a: 1 })
  })
})

describe('formatMcpResult', () => {
  it('joins text parts and ignores non-text parts', () => {
    expect(
      formatMcpResult({
        content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x', mimeType: 'png' }, { type: 'text', text: 'b' }],
      }),
    ).toBe('a\nb')
  })

  it('returns empty string for no content', () => {
    expect(formatMcpResult({ content: [] })).toBe('')
  })
})
