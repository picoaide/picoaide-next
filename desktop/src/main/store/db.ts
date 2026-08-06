import Database from 'better-sqlite3'

export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 1000')
  db.pragma('foreign_keys = ON')
  // 审计3-L4:并发写(引擎写库/后台任务)争锁时等待 3s 而非立即 SQLITE_BUSY
  db.pragma('busy_timeout = 3000')
  return db
}
