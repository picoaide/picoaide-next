import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from './db'
import { migrate } from './migrations'
import { getSetting, setSetting } from './settings'

function openTestDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'picoaide-set-test-'))
  const db = openDb(join(dir, 'test.db'))
  migrate(db)
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('settings', () => {
  it('getSetting returns null for missing keys', () => {
    const { db, cleanup } = openTestDb()
    try {
      expect(getSetting(db, 'nope')).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('setSetting then getSetting round trips, setSetting overwrites', () => {
    const { db, cleanup } = openTestDb()
    try {
      setSetting(db, 'theme', 'dark')
      expect(getSetting(db, 'theme')).toBe('dark')
      setSetting(db, 'theme', 'light')
      expect(getSetting(db, 'theme')).toBe('light')
    } finally {
      cleanup()
    }
  })
})
