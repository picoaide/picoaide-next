import type Database from 'better-sqlite3'

export type ConversationStatus = 'running' | 'executing' | 'planning' | 'approved' | 'rejected' | 'done' | 'failed'

export interface ConversationRow {
  id: number
  title: string
  mode: string
  status: string
  model: string
  workspace: string
  project_id: number | null
  starred: number
  archived: number
  created_at: string
  updated_at: string
  preview?: string | null
}

export interface CreateConversationInput {
  title?: string
  mode?: string
  model?: string
  workspace?: string
  projectId?: number | null
}

export function createConversation(db: Database.Database, input: CreateConversationInput = {}): number {
  const info = db
    .prepare('INSERT INTO conversations (title, mode, model, workspace, project_id) VALUES (?, ?, ?, ?, ?)')
    .run(input.title ?? '', input.mode ?? 'ask', input.model ?? '', input.workspace ?? '', input.projectId ?? null)
  return Number(info.lastInsertRowid)
}

export function setConversationWorkspace(db: Database.Database, id: number, workspace: string): void {
  db.prepare('UPDATE conversations SET workspace = ? WHERE id = ?').run(workspace, id)
}

export function listConversations(db: Database.Database): ConversationRow[] {
  return db
    .prepare(
      `SELECT c.*,
        (SELECT substr(m.content, 1, 60) FROM messages m
          WHERE m.conversation_id = c.id AND m.role = 'assistant' AND m.content <> ''
          ORDER BY m.id DESC LIMIT 1) AS preview
        FROM conversations c ORDER BY c.updated_at DESC, c.id DESC`,
    )
    .all() as ConversationRow[]
}

export function getConversation(db: Database.Database, id: number): ConversationRow | null {
  return (db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined) ?? null
}

export function updateConversationStatus(db: Database.Database, id: number, status: ConversationStatus): void {
  db.prepare('UPDATE conversations SET status = ?, updated_at = strftime(\'%Y-%m-%d %H:%M:%f\',\'now\',\'localtime\') WHERE id = ?').run(status, id)
}

export function touchConversation(db: Database.Database, id: number): void {
  db.prepare('UPDATE conversations SET updated_at = strftime(\'%Y-%m-%d %H:%M:%f\',\'now\',\'localtime\') WHERE id = ?').run(id)
}

export function deleteConversation(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function setConversationTitle(db: Database.Database, id: number, title: string): void {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
}

// chatbox 会话管理:置顶 / 归档
export function setConversationStarred(db: Database.Database, id: number, starred: boolean): void {
  db.prepare('UPDATE conversations SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id)
}

export function setConversationArchived(db: Database.Database, id: number, archived: boolean): void {
  db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}
