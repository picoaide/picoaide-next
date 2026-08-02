import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from './db'
import { migrate } from './migrations'
import { createConversation, deleteConversation, getConversation, listConversations, setConversationTitle, touchConversation, updateConversationStatus } from './conversations'
import { appendMessage, listMessages } from './messages'

function openTestDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'picoaide-conv-test-'))
  const db = openDb(join(dir, 'test.db'))
  migrate(db)
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('conversations', () => {
  it('createConversation returns an id and defaults to status done', () => {
    const { db, cleanup } = openTestDb()
    try {
      const id = createConversation(db, { title: 'hi' })
      const row = getConversation(db, id)
      expect(row).not.toBeNull()
      expect(row!.title).toBe('hi')
      expect(row!.status).toBe('done')
      expect(row!.mode).toBe('ask')
    } finally {
      cleanup()
    }
  })

  it('listConversations orders by updated_at DESC, touch moves a row to the top', async () => {
    const { db, cleanup } = openTestDb()
    try {
      const a = createConversation(db, { title: 'a' })
      const b = createConversation(db, { title: 'b' })
      expect(listConversations(db).map((r) => r.id)).toEqual([b, a])
      await new Promise((resolve) => setTimeout(resolve, 5))
      touchConversation(db, a)
      expect(listConversations(db).map((r) => r.id)).toEqual([a, b])
    } finally {
      cleanup()
    }
  })

  it('getConversation returns null for missing id', () => {
    const { db, cleanup } = openTestDb()
    try {
      expect(getConversation(db, 999)).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('updateConversationStatus and setConversationTitle persist', () => {
    const { db, cleanup } = openTestDb()
    try {
      const id = createConversation(db, { title: 'x' })
      updateConversationStatus(db, id, 'running')
      setConversationTitle(db, id, 'y')
      const row = getConversation(db, id)
      expect(row!.status).toBe('running')
      expect(row!.title).toBe('y')
    } finally {
      cleanup()
    }
  })

  it('deleteConversation cascades to messages', () => {
    const { db, cleanup } = openTestDb()
    try {
      const id = createConversation(db, { title: 'to-delete' })
      appendMessage(db, { conversationId: id, role: 'user', content: 'hello' })
      appendMessage(db, { conversationId: id, role: 'assistant', content: 'world' })
      expect(listMessages(db, id)).toHaveLength(2)
      deleteConversation(db, id)
      expect(getConversation(db, id)).toBeNull()
      expect(listMessages(db, id)).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})
