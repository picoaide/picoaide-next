package serverstore

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return db
}

func TestApplyMigrations(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	var version int64
	if err := db.QueryRow("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").Scan(&version); err != nil {
		t.Fatalf("schema_migrations: %v", err)
	}
	if version != latestMigration {
		t.Fatalf("version = %d, want %d", version, latestMigration)
	}

	// idempotent
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("second ApplyMigrations: %v", err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != len(migrations) {
		t.Fatalf("migration rows = %d, want %d", n, len(migrations))
	}
}

func TestApplyMigrationsFailure(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	// Re-apply with a broken migration appended should fail, not panic.
	migrations = append(migrations, migration{version: 999, name: "broken", sql: "THIS IS NOT SQL"})
	defer func() { migrations = migrations[:len(migrations)-1] }()
	if err := ApplyMigrations(db); err == nil {
		t.Fatal("expected error for broken migration, got nil")
	}
}

// 审计 A5-M9(0026): 存量同名 mcp_servers 去重 —— 每名保留最小 id 的一行,
// grants / downloads 引用迁移到保留行,随后唯一索引生效。
func TestMigration0026MCPServerNameUnique(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	// 先只应用 0025 及之前的迁移(此时 name 无唯一约束),构造重复数据
	keep := migrations
	filtered := make([]migration, 0, len(migrations))
	for _, m := range migrations {
		if m.version == 26 {
			continue
		}
		filtered = append(filtered, m)
	}
	migrations = filtered
	defer func() { migrations = keep }()
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("pre-0026 apply: %v", err)
	}

	id1, err := AddMCPServer(db, &MCPServer{Name: "files", Transport: "stdio", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	id2, err := AddMCPServer(db, &MCPServer{Name: "files", Transport: "stdio", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	id3, err := AddMCPServer(db, &MCPServer{Name: "files", Transport: "stdio", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 重复行上的 grants 与 downloads
	if err := GrantMCP(db, id2, "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	if err := GrantMCP(db, id3, "研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	aliceID, err := CreateUserWithPassword(db, "alice", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	if err := RecordDownload(db, aliceID, id3); err != nil {
		t.Fatal(err)
	}

	// 应用 0026:去重 + 引用迁移 + 唯一索引
	migrations = keep
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("apply 0026: %v", err)
	}

	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM mcp_servers WHERE name = 'files'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("mcp rows after dedupe = %d, want 1", n)
	}
	var kept int
	if err := db.QueryRow("SELECT id FROM mcp_servers WHERE name = 'files'").Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != int(id1) {
		t.Fatalf("kept id = %d, want %d (min id)", kept, id1)
	}
	// grants 全量迁移到保留行
	grants, err := ListMCPGrants(db, id1)
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 2 {
		t.Fatalf("grants after dedupe = %+v, want 2", grants)
	}
	// downloads 重指向保留行
	rows, total, err := ListDownloadsPaged(db, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(rows) != 1 || rows[0].MCPID != id1 {
		t.Fatalf("downloads after dedupe = %+v total=%d, want 1 row on id %d", rows, total, id1)
	}
	// 唯一索引生效
	if _, err := AddMCPServer(db, &MCPServer{Name: "files", Transport: "stdio"}); err != ErrDuplicate {
		t.Fatalf("post-0026 duplicate insert err = %v, want ErrDuplicate", err)
	}
}
