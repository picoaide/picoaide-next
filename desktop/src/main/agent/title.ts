const MAX_TITLE_LEN = 20

export function fallbackTitle(text: string): string {
  return text.trim().slice(0, MAX_TITLE_LEN)
}

export interface TitleSession {
  serverURL: string
  token: string
}

// 调网关默认模型生成 ≤20 字标题;失败抛错由调用方兜底。fetchFn 默认注入以便测试
export async function generateTitle(
  session: TitleSession,
  modelId: string,
  firstUserText: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(`${session.serverURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 40,
        temperature: 0,
        messages: [
          { role: 'system', content: `为下面的用户消息生成一个不超过${MAX_TITLE_LEN}字的会话标题,只输出标题本身,不要引号。` },
          { role: 'user', content: firstUserText.slice(0, 500) },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`title generation failed: ${res.status}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content?.trim() ?? ''
    return content.slice(0, MAX_TITLE_LEN)
  } finally {
    clearTimeout(timer)
  }
}
