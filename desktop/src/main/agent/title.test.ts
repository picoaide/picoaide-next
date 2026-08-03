import { describe, expect, it } from 'vitest'
import { fallbackTitle, generateTitle } from './title'
import type { LanguageModel } from 'ai'

// 仿 engine.test FakeProvider 的最小语言模型(mock generateText 所需的 doStream);cast 而非 implements
class FakeTitleModel {
  readonly specificationVersion = 'v4' as const
  readonly provider = 'fake'
  readonly modelId = 'fake-title'

  script: 'text' | 'fail' | 'hang' | 'empty'
  constructor(script: 'text' | 'fail' | 'hang' | 'empty' = 'text') {
    this.script = script
  }

  async doGenerate(options: any) {
    if (this.script === 'fail') throw new Error('upstream 502')
    if (this.script === 'hang') {
      await new Promise((r) => setTimeout(r, 1000))
      throw new DOMException('Aborted', 'AbortError')
    }
    const hasApprovalOrTool = Array.isArray(options.prompt) && options.prompt.some((m: any) => m?.role === 'tool')
    void hasApprovalOrTool
    return {
      content: [{ type: 'text', text: this.script === 'empty' ? '  ' : '这是一段很长的标题用来测试截断行为是否正常生效' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } },
      warnings: [],
    }
  }

  async doStream(options: any) {
    if (this.script === 'fail') throw new Error('upstream 502')
    if (this.script === 'hang') {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 't1' })
          },
        }),
      }
    }
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't1' })
          controller.enqueue({ type: 'text-delta', id: 't1', delta: '这是一段很长的标题用来测试截断行为是否正常生效' })
          controller.enqueue({ type: 'text-end', id: 't1' })
          controller.enqueue({
            type: 'finish',
            usage: { promptTokens: { total: 5 }, completionTokens: { total: 5 } },
            finishReason: { unified: 'stop', raw: undefined },
          })
        },
      }),
    }
  }
}

describe('generateTitle', () => {
  it('解析模型输出并截断 20 字', async () => {
    const t = await generateTitle(new FakeTitleModel('text') as unknown as LanguageModel, '帮我写周报')
    expect(t).toHaveLength(20)
  })

  it('模型失败时抛错(由调用方兜底)', async () => {
    await expect(generateTitle(new FakeTitleModel('fail') as unknown as LanguageModel, 'x')).rejects.toThrow()
  })

  it('空内容返回空串', async () => {
    expect(await generateTitle(new FakeTitleModel('empty') as unknown as LanguageModel, 'x')).toBe('')
  })
})

describe('fallbackTitle', () => {
  it('截取前 20 字符', () => {
    expect(fallbackTitle('  帮我整理一下这个月的报销单据并生成表格  ')).toBe('帮我整理一下这个月的报销单据并生成表格')
  })
})
