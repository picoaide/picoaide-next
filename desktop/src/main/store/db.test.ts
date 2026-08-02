import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db'
import { migrate } from './migrations'

function tmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'picoaide-db-test-'))
  return { dbPath: join(dir, 'test.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('db', () => {
  it('openDb creates a WAL file database with foreign keys enabled', () => {
    const { dbPath, cleanup } = tmpDb()
    const db = openDb(dbPath)
    db.close()
    cleanup()
  })

  it('after migrate, schema_migrations and the 4 business tables exist', () => {
    const { dbPath, cleanup } = tmpDb()
    const db = openDb(dbPath)
    try {
      migrate(db)
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
      const names = rows.map((r) => r.name)
      for (const expected of ['schema_migrations', 'conversations', 'messages', 'artifacts', 'settings']) {
        expect(names).toContain(expected)
      }
      const cols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]
      expect(cols.map((c) => c.name)).toContain('status')
      const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
      for (const expected of ['tool_calls', 'tool_call_id', 'tool_name', 'is_error']) {
        expect(msgCols.map((c) => c.name)).toContain(expected)
      }
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    } finally {
      db.close()
      cleanup()
    }
  })

  it('migrate is idempotent', () => {
    const { dbPath, cleanup } = tmpDb()
    const db = openDb(dbPath)
    try {
      migrate(db)
      migrate(db)
      const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]
      expect(rows).toEqual([{ version: 1 }])
    } finally {
      db.close()
      cleanup()
    }
  })
})
