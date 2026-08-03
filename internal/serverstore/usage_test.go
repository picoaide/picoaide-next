package serverstore

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

func newUsageDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	db, err := EnsureMigrated(fmt.Sprintf("%s/usage.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	return db, func() { db.Close() }
}

func mustUserID(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	id, err := CreateUser(db, &User{Username: "u" + fmt.Sprint(time.Now().UnixNano()), Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// setCreatedAt backdates a usage row so day aggregation is deterministic.
func setCreatedAt(t *testing.T, db *sql.DB, id int64, ts string) {
	t.Helper()
	if _, err := db.Exec("UPDATE usage SET created_at = ? WHERE id = ?", ts, id); err != nil {
		t.Fatal(err)
	}
}

func TestRecordUsageReturnsID(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	id, err := RecordUsage(db, uid, "deepseek-chat", 10, 5)
	if err != nil {
		t.Fatal(err)
	}
	if id == 0 {
		t.Fatal("expected non-zero row id")
	}

	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage WHERE id = ?", id).Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 10 || ct != 5 {
		t.Fatalf("pt=%d ct=%d", pt, ct)
	}
}

func TestUpdateUsageTokens(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	id, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0)
	if err := UpdateUsageTokens(db, id, 42, 7); err != nil {
		t.Fatal(err)
	}
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage WHERE id = ?", id).Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 42 || ct != 7 {
		t.Fatalf("pt=%d ct=%d", pt, ct)
	}
}

func TestUsageByUserPerDay(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	other := mustUserID(t, db)

	id1, _ := RecordUsage(db, uid, "deepseek-chat", 10, 5)
	id2, _ := RecordUsage(db, uid, "deepseek-chat", 20, 10)
	id3, _ := RecordUsage(db, uid, "qwen-plus", 1, 1)
	id4, _ := RecordUsage(db, other, "deepseek-chat", 100, 100)
	setCreatedAt(t, db, id1, "2026-08-01 09:00:00")
	setCreatedAt(t, db, id2, "2026-08-01 10:00:00")
	setCreatedAt(t, db, id3, "2026-08-02 09:00:00")
	setCreatedAt(t, db, id4, "2026-08-01 09:00:00")

	since := time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local)
	until := time.Date(2026, 8, 3, 0, 0, 0, 0, time.Local)
	days, err := UsageByUser(db, uid, since, until)
	if err != nil {
		t.Fatal(err)
	}
	if len(days) != 2 {
		t.Fatalf("got %d days: %+v", len(days), days)
	}
	if days[0].Day != "2026-08-01" || days[0].PromptTokens != 30 || days[0].CompletionTokens != 15 {
		t.Fatalf("day1 = %+v", days[0])
	}
	if days[1].Day != "2026-08-02" || days[1].PromptTokens != 1 || days[1].CompletionTokens != 1 {
		t.Fatalf("day2 = %+v", days[1])
	}
}

func TestUsageTotal(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	id1, _ := RecordUsage(db, uid, "deepseek-chat", 10, 5)
	id2, _ := RecordUsage(db, uid, "qwen-plus", 30, 20)
	setCreatedAt(t, db, id1, "2026-08-01 09:00:00")
	setCreatedAt(t, db, id2, "2026-08-02 09:00:00")

	since := time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local)
	until := time.Date(2026, 8, 3, 0, 0, 0, 0, time.Local)
	tot, err := UsageTotal(db, since, until)
	if err != nil {
		t.Fatal(err)
	}
	if tot.PromptTokens != 40 || tot.CompletionTokens != 25 {
		t.Fatalf("total = %+v", tot)
	}

	// narrow window excludes day 2
	tot, err = UsageTotal(db, time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local), time.Date(2026, 8, 2, 0, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatal(err)
	}
	if tot.PromptTokens != 10 || tot.CompletionTokens != 5 {
		t.Fatalf("narrow total = %+v", tot)
	}
}

func TestCleanupPendingUsage(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	pending, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0)     // zero tokens
	keptPending, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0) // zero tokens, recent
	complete, _ := RecordUsage(db, uid, "deepseek-chat", 10, 5)   // has tokens, old
	setCreatedAt(t, db, pending, "2026-07-01 09:00:00")
	setCreatedAt(t, db, keptPending, "2026-08-02 09:00:00")
	setCreatedAt(t, db, complete, "2026-07-01 09:00:00")

	cutoff := time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local)
	if err := CleanupPendingUsage(db, cutoff); err != nil {
		t.Fatal(err)
	}

	for _, id := range []int64{pending} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE id = ?", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("pending row %d not cleaned", id)
		}
	}
	for _, id := range []int64{keptPending, complete} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE id = ?", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("row %d wrongly cleaned", id)
		}
	}
}

func TestUsageAggregateEmptyReturnsNonNil(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "day")
	if err != nil {
		t.Fatal(err)
	}
	if rows == nil {
		t.Fatal("UsageAggregate returned nil slice on empty table (must be [] for JSON)")
	}
}
