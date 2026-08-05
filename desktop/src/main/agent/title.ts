import { generateText, type LanguageModel } from 'ai'

const MAX_TITLE_LEN = 20

export function fallbackTitle(text: string): string {
  return text.trim().slice(0, MAX_TITLE_LEN)
}

// 调网关默认模型生成 ≤20 字标题;失败抛错由调用方兜底。
// 用 AI SDK generateText(框架能力),模型由调用方注入(index.ts makeGatewayModel)。
// fetch 必须注入 session.defaultSession.fetch(证书校验/TOFU 生效):不注入时走全局
// fetch,自签证书场景下信任判定与引擎路径不一致,且系统 CA 信任的 MITM 证书会在
// 此处放行(其余路径拒绝)。
export async function generateTitle(
  model: LanguageModel,
  firstUserText: string,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<string> {
  const { text } = await generateText({
    model,
    system: `为下面的用户消息生成一个不超过${MAX_TITLE_LEN}字的会话标题,只输出标题本身,不要引号。`,
    prompt: firstUserText.slice(0, 500),
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    maxRetries: 0,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
  return text.trim().slice(0, MAX_TITLE_LEN)
}

