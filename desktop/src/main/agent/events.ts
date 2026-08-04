// 事件契约(实施计划 §0.4.3,字段 snake_case,与架构设计 §3.3.3 完全一致)
// conversationId:运行任务所属会话(引擎自动附加);renderer 按 activeId 过滤,
// 防止旧会话运行的迟到事件污染新会话 UI(切会话/新建/登出场景)
export type AgentEvent =
  | { type: 'text_delta'; conversationId: number; data: string }
  | { type: 'reasoning_delta'; conversationId: number; data: string }
  | { type: 'tool_start'; conversationId: number; data: { id: string; name: string; input: unknown } }
  | { type: 'tool_end'; conversationId: number; data: { id: string; name: string; output: unknown; duration_ms: number } }
  | { type: 'tool_error'; conversationId: number; data: { id: string; name: string; error: string } }
  | { type: 'confirm_required'; conversationId: number; data: { request_id: string; tool_call_id: string; op: string; target: string; reason: string } }
  | { type: 'artifact'; conversationId: number; data: { path: string; type: string; size: number } }
  | { type: 'done'; conversationId: number; data: { usage?: { prompt_tokens: number; completion_tokens: number } } }
  | { type: 'canceled'; conversationId: number; data: { reason: string } }
  | { type: 'error'; conversationId: number; data: string }

// 类型化事件发射器:引擎使用、测试可订阅、后续 ipc 桥接直接复用
export class AgentEventEmitter {
  private listeners = new Set<(ev: AgentEvent) => void>()

  on(cb: (ev: AgentEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  emit(ev: AgentEvent): void {
    for (const cb of this.listeners) cb(ev)
  }
}
