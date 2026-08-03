import type Database from 'better-sqlite3'

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface MessageRow {
  id: number
  conversation_id: number
  role: string
  content: string
  reasoning: string
  tool_calls: string
  tool_call_id: string
  tool_name: string
  is_error: number
  created_at: string
}

export interface AppendMessageInput {
  conversationId: number
  role: MessageRole
  content?: string
  reasoning?: string
  toolCalls?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export function appendMessage(db: Database.Database, input: AppendMessageInput): number {
  const info = db
    .prepare(
      'INSERT INTO messages (conversation_id, role, content, reasoning, tool_calls, tool_call_id, tool_name, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.conversationId,
      input.role,
      input.content ?? '',
      input.reasoning ?? '',
      input.toolCalls ?? '[]',
      input.toolCallId ?? '',
      input.toolName ?? '',
      input.isError ? 1 : 0,
    )
  return Number(info.lastInsertRowid)
}

export function listMessages(db: Database.Database, conversationId: number): MessageRow[] {
  return db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(conversationId) as MessageRow[]
}

export function updateMessageContent(db: Database.Database, id: number, content: string): void {
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id)
}

// 删除指定会话内、指定消息之后的所有消息(chatbox 消息编辑语义:改 user 消息后截断该轮重跑)
export function deleteMessagesAfter(db: Database.Database, conversationId: number, messageId: number): void {
  db.prepare('DELETE FROM messages WHERE conversation_id = ? AND id > ?').run(conversationId, messageId)
}

export function deleteMessage(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id)
}

export function deleteMessages(db: Database.Database, conversationId: number): void {
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
}
