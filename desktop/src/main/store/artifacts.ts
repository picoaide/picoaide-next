import type Database from 'better-sqlite3'

export interface ArtifactRow {
  id: number
  conversation_id: number
  path: string
  type: string
  size: number
  created_at: string
}

export interface AddArtifactInput {
  conversationId: number
  path: string
  type?: string
  size?: number
}

export function addArtifact(db: Database.Database, input: AddArtifactInput): number {
  const info = db
    .prepare('INSERT INTO artifacts (conversation_id, path, type, size) VALUES (?, ?, ?, ?)')
    .run(input.conversationId, input.path, input.type ?? 'file', input.size ?? 0)
  return Number(info.lastInsertRowid)
}

export function listArtifacts(db: Database.Database, conversationId: number): ArtifactRow[] {
  return db
    .prepare('SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY id ASC')
    .all(conversationId) as ArtifactRow[]
}
