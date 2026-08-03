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
  created_at: string
  updated_at: string
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
  return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, id DESC').all() as ConversationRow[]
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
