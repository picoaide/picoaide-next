import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from './migrations'
import { createProject, deleteProject, listProjects, setConversationProject, workspaceFor } from './projects'
import { createConversation } from './conversations'

function openDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('projects store', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openDb()
  })

  it('create + list', () => {
    const id = createProject(db, { name: '文档项目', path: '/tmp/doc' })
    expect(listProjects(db)).toHaveLength(1)
    expect(listProjects(db)[0]).toMatchObject({ id, name: '文档项目', path: '/tmp/doc' })
  })

  it('重复 path 抛错', () => {
    createProject(db, { name: 'a', path: '/tmp/doc' })
    expect(() => createProject(db, { name: 'b', path: '/tmp/doc' })).toThrow()
  })

  it('delete 解除会话关联(project_id 置 NULL,会话保留)', () => {
    const pid = createProject(db, { name: 'a', path: '/tmp/doc' })
    const cid = createConversation(db, { projectId: pid })
    deleteProject(db, pid)
    expect(listProjects(db)).toHaveLength(0)
    const conv = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(cid) as { project_id: number | null }
    expect(conv.project_id).toBeNull()
  })

  it('setConversationProject 移动会话', () => {
    const pid = createProject(db, { name: 'a', path: '/tmp/a' })
    const cid = createConversation(db, {})
    setConversationProject(db, cid, pid)
    const row = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(cid) as { project_id: number | null }
    expect(row.project_id).toBe(pid)
    setConversationProject(db, cid, null)
    const row2 = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(cid) as { project_id: number | null }
    expect(row2.project_id).toBeNull()
  })

  it('workspaceFor = 项目路径/会话id', () => {
    expect(workspaceFor('/tmp/proj', 42)).toBe('/tmp/proj/42')
  })
})
