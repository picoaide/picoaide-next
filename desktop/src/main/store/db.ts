import Database from 'better-sqlite3'

export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 1000')
  db.pragma('foreign_keys = ON')
  return db
}
