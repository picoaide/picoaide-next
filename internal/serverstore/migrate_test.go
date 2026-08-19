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

// TestUsageCreatedAtIndex: 迁移 0025 必须创建 created_at 单列索引,
// 否则 UsageAggregate 的纯日期范围聚合会全表扫描(审计高3)。
func TestUsageCreatedAtIndex(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	var name string
	if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_time'`).Scan(&name); err != nil {
		t.Fatalf("idx_usage_time missing after migration: %v", err)
	}
	// 索引应覆盖 created_at(纯日期范围过滤的驱动列)
	if _, err := db.Exec(`SELECT COUNT(*) FROM usage WHERE created_at >= '2026-01-01' AND created_at < '2026-02-01'`); err != nil {
		t.Fatalf("query with created_at range: %v", err)
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

// 0027:user_groups(group_id) 索引(审计 L3:N+1/全表扫治理)——迁移后索引必须存在。
func TestMigration0027UserGroupsGroupIndex(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'index' AND name = 'idx_user_groups_group'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("idx_user_groups_group index missing (n=%d)", n)
	}
}
