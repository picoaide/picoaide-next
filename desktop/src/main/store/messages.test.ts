import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from './db'
import { migrate } from './migrations'
import { createConversation } from './conversations'
import { appendMessage, deleteMessages, deleteMessagesAfter, listMessages, updateMessageContent } from './messages'

function openTestDb(): { db: Database.Database; convId: number; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'picoaide-msg-test-'))
  const db = openDb(join(dir, 'test.db'))
  migrate(db)
  const convId = createConversation(db, { title: 't' })
  return { db, convId, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('messages', () => {
  it('appendMessage then listMessages returns rows by id ASC with snake_case keys', () => {
    const { db, convId, cleanup } = openTestDb()
    try {
      const m1 = appendMessage(db, { conversationId: convId, role: 'user', content: 'first' })
      const m2 = appendMessage(db, { conversationId: convId, role: 'assistant', content: 'second' })
      expect(m2).toBeGreaterThan(m1)
      const rows = listMessages(db, convId)
      expect(rows.map((r) => r.content)).toEqual(['first', 'second'])
      expect(Object.keys(rows[0])).toEqual(
        expect.arrayContaining(['id', 'conversation_id', 'role', 'content', 'reasoning', 'tool_calls', 'tool_call_id', 'tool_name', 'is_error', 'created_at']),
      )
    } finally {
      cleanup()
    }
  })

  it('tool_call_id, tool_name, is_error round trip', () => {
    const { db, convId, cleanup } = openTestDb()
    try {
      const id = appendMessage(db, {
        conversationId: convId,
        role: 'tool',
        content: 'boom',
        toolCallId: 'call_1',
        toolName: 'read_file',
        isError: true,
      })
      const row = listMessages(db, convId)[0]
      expect(row.id).toBe(id)
      expect(row.tool_call_id).toBe('call_1')
      expect(row.tool_name).toBe('read_file')
      expect(row.is_error).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('tool_calls JSON string round trips', () => {
    const { db, convId, cleanup } = openTestDb()
    try {
      const calls = [{ id: 'call_2', name: 'list_files', args: { path: '/tmp' } }]
      appendMessage(db, { conversationId: convId, role: 'assistant', content: '', toolCalls: JSON.stringify(calls) })
      const row = listMessages(db, convId)[0]
      expect(JSON.parse(row.tool_calls)).toEqual(calls)
    } finally {
      cleanup()
    }
  })

  it('updateMessageContent overwrites content (streaming deltas)', () => {
    const { db, convId, cleanup } = openTestDb()
    try {
      const id = appendMessage(db, { conversationId: convId, role: 'assistant', content: 'partial' })
      updateMessageContent(db, id, 'full text')
      expect(listMessages(db, convId)[0].content).toBe('full text')
    } finally {
      cleanup()
    }
  })

  it('deleteMessages removes all messages of a conversation', () => {
    const { db, convId, cleanup } = openTestDb()
    try {
      appendMessage(db, { conversationId: convId, role: 'user', content: 'x' })
      appendMessage(db, { conversationId: convId, role: 'assistant', content: 'y' })
      deleteMessages(db, convId)
      expect(listMessages(db, convId)).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  it('deleteMessagesAfter removes messages after the given id only', () => {
    const { db, convId, cleanup } = openTestDb()
    try {
      const m1 = appendMessage(db, { conversationId: convId, role: 'user', content: 'edited' })
      const m2 = appendMessage(db, { conversationId: convId, role: 'assistant', content: 'old answer' })
      const m3 = appendMessage(db, { conversationId: convId, role: 'user', content: 'followup' })
      deleteMessagesAfter(db, m1)
      const left = listMessages(db, convId)
      expect(left.map((m) => m.id)).toEqual([m1])
      void m2
      void m3
    } finally {
      cleanup()
    }
  })
})
