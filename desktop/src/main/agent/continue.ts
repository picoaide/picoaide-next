import type { AgentEngine, DBMessage } from './engine'

// 重跑恢复(架构设计 §3.3.1a):截断到最后一条 user 消息,其后的 assistant/tool 行保留在 DB 供查看但不进入上下文
export function lastUserMessageIndex(rows: DBMessage[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') return i
  }
  return -1
}

// 无工具上下文的重跑(ask/探针场景);带工具的重跑由 ipc 层经 engine.continueConversation 直接发起
export async function continueConversation(engine: AgentEngine, conversationId: number): Promise<void> {
  await engine.continueConversation({ conversationId })
}
