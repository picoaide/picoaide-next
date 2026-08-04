import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from './db'
import { migrate } from './migrations'
import { createConversation, deleteConversation, getConversation, listConversations, setConversationTitle, setConversationWorkspace, touchConversation, updateConversationStatus } from './conversations'
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

  it('listConversations includes the latest assistant message preview per conversation', async () => {
    const { db, cleanup } = openTestDb()
    try {
      const cid = createConversation(db, { title: 'c' })
      appendMessage(db, { conversationId: cid, role: 'user', content: '帮我写周报' })
      appendMessage(db, { conversationId: cid, role: 'assistant', content: '这是本周的周报草稿,请查收。'.repeat(5) })
      const rows = listConversations(db)
      expect(rows[0].preview).toBe('这是本周的周报草稿,请查收。'.repeat(5).slice(0, 60))
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

  it('createConversation 支持 projectId', () => {
    const { db, cleanup } = openTestDb()
    try {
      const id = createConversation(db, { projectId: 7 })
      const row = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(id) as { project_id: number | null }
      expect(row.project_id).toBe(7)
      expect(getConversation(db, id)!.project_id).toBe(7)
    } finally {
      cleanup()
    }
  })

  it('setConversationWorkspace 更新 workspace', () => {
    const { db, cleanup } = openTestDb()
    try {
      const id = createConversation(db, {})
      expect(getConversation(db, id)!.workspace).toBe('')
      const ws = '/proj/1'
      setConversationWorkspace(db, id, ws)
      expect(getConversation(db, id)!.workspace).toBe(ws)
    } finally {
      cleanup()
    }
  })
})
