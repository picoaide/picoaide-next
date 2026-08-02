import type Database from 'better-sqlite3'

const migrations: string[] = [
  `CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'ask',
    status TEXT NOT NULL DEFAULT 'done',
    model TEXT NOT NULL DEFAULT '',
    workspace TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now','localtime')),
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now','localtime'))
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '',
    tool_calls TEXT NOT NULL DEFAULT '[]',
    tool_call_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL DEFAULT '',
    is_error INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_messages_conv ON messages(conversation_id);
  CREATE TABLE artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'file',
    size INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
]

export function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`)
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  )
  const insert = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)')
  for (const [i, sql] of migrations.entries()) {
    const version = i + 1
    if (applied.has(version)) continue
    db.transaction(() => {
      db.exec(sql)
      insert.run(version)
    })()
  }
}
