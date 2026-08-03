import { describe, expect, it, vi } from 'vitest'
import { fallbackTitle, generateTitle } from './title'

const session = { serverURL: 'https://gw.example.com', token: 'tok' }

describe('generateTitle', () => {
  it('解析网关返回的标题并截断 20 字', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '这是一段很长的标题用来测试截断行为是否正常生效' } }] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch
    const t = await generateTitle(session, 'm1', '帮我写周报', fetchFn)
    expect(t).toHaveLength(20)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://gw.example.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('网关失败时抛错(由调用方兜底)', async () => {
    const fetchFn = vi.fn(async () => new Response('err', { status: 500 })) as unknown as typeof fetch
    await expect(generateTitle(session, 'm1', 'x', fetchFn)).rejects.toThrow()
  })

  it('超时抛错', async () => {
    const fetchFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 1000))
      throw new DOMException('Aborted', 'AbortError')
    }) as unknown as typeof fetch
    await expect(generateTitle(session, 'm1', 'x', fetchFn, 50)).rejects.toThrow()
  })

  it('空内容返回空串', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), { status: 200 }),
    ) as unknown as typeof fetch
    expect(await generateTitle(session, 'm1', 'x', fetchFn)).toBe('')
  })
})

describe('fallbackTitle', () => {
  it('截取前 20 字符', () => {
    expect(fallbackTitle('  帮我整理一下这个月的报销单据并生成表格  ')).toBe('帮我整理一下这个月的报销单据并生成表格')
  })
})
