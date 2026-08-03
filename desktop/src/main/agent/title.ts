import { generateText, type LanguageModel } from 'ai'

const MAX_TITLE_LEN = 20

export function fallbackTitle(text: string): string {
  return text.trim().slice(0, MAX_TITLE_LEN)
}

// 调网关默认模型生成 ≤20 字标题;失败抛错由调用方兜底。
// 用 AI SDK generateText(框架能力),模型由调用方注入(index.ts makeGatewayModel)
export async function generateTitle(
  model: LanguageModel,
  firstUserText: string,
  timeoutMs = 15000,
): Promise<string> {
  const { text } = await generateText({
    model,
    system: `为下面的用户消息生成一个不超过${MAX_TITLE_LEN}字的会话标题,只输出标题本身,不要引号。`,
    prompt: firstUserText.slice(0, 500),
    abortSignal: AbortSignal.timeout(timeoutMs),
    maxRetries: 0,
  })
  return text.trim().slice(0, MAX_TITLE_LEN)
}

