// 事件契约(实施计划 §0.4.3,字段 snake_case,与架构设计 §3.3.3 完全一致)
export type AgentEvent =
  | { type: 'text_delta'; data: string }
  | { type: 'reasoning_delta'; data: string }
  | { type: 'tool_start'; data: { id: string; name: string; input: unknown } }
  | { type: 'tool_end'; data: { id: string; name: string; output: unknown; duration_ms: number } }
  | { type: 'tool_error'; data: { id: string; name: string; error: string } }
  | { type: 'confirm_required'; data: { request_id: string; tool_call_id: string; op: string; target: string; reason: string } }
  | { type: 'artifact'; data: { path: string; type: string; size: number } }
  | { type: 'done'; data: { usage?: { prompt_tokens: number; completion_tokens: number } } }
  | { type: 'canceled'; data: { reason: string } }
  | { type: 'error'; data: string }

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
