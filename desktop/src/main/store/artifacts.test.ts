import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from './db'
import { migrate } from './migrations'
import { createConversation } from './conversations'
import { addArtifact, listArtifacts } from './artifacts'

function openTestDb(): { db: Database.Database; convId: number; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'picoaide-art-test-'))
  const db = openDb(join(dir, 'test.db'))
  migrate(db)
  const convId = createConversation(db, { title: 't' })
  return { db, convId, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('artifacts', () => {
  it('addArtifact then listArtifacts returns rows by id ASC', () => {
    const { db, convId, cleanup } = openTestDb()
    try {
      const a1 = addArtifact(db, { conversationId: convId, path: '/tmp/a.md', type: 'file', size: 10 })
      const a2 = addArtifact(db, { conversationId: convId, path: '/tmp/b.md', type: 'file', size: 20 })
      expect(a2).toBeGreaterThan(a1)
      const rows = listArtifacts(db, convId)
      expect(rows.map((r) => r.path)).toEqual(['/tmp/a.md', '/tmp/b.md'])
      expect(rows[0].type).toBe('file')
      expect(rows[0].size).toBe(10)
      expect(rows[0].conversation_id).toBe(convId)
    } finally {
      cleanup()
    }
  })
})
