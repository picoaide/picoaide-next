import { join } from 'node:path'
import type Database from 'better-sqlite3'

export interface ProjectRow {
  id: number
  name: string
  path: string
  created_at: string
}

export function createProject(db: Database.Database, input: { name: string; path: string }): number {
  return Number(db.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run(input.name, input.path).lastInsertRowid)
}

export function listProjects(db: Database.Database): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC, id DESC').all() as ProjectRow[]
}

export function getProject(db: Database.Database, id: number): ProjectRow | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined) ?? null
}

// 删除项目:仅解除会话关联,不删任何文件
export function deleteProject(db: Database.Database, id: number): void {
  db.transaction(() => {
    db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })()
}

export function setConversationProject(db: Database.Database, conversationId: number, projectId: number | null): void {
  db.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(projectId, conversationId)
}

// 项目内会话 workspace = <项目目录>/<会话id>
export function workspaceFor(projectPath: string, conversationId: number): string {
  return join(projectPath, String(conversationId))
}
