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

// TestUserMonthlyUsage: only current-calendar-month rows count; pending
// (zero-token) rows and prior-month rows are excluded.
func TestUserMonthlyUsage(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	thisMonth := monthStart(time.Now()).AddDate(0, 0, 5)
	lastMonth := monthStart(time.Now()).AddDate(0, -1, 15)

	for _, ts := range []time.Time{thisMonth, thisMonth, lastMonth} {
		id, _ := RecordUsage(db, uid, "m", 10, 5)
		setCreatedAt(t, db, id, ts.Format(sqliteTimeFmt))
	}
	// pending row this month must not count
	pending, _ := RecordUsage(db, uid, "m", 0, 0)
	setCreatedAt(t, db, pending, thisMonth.Format(sqliteTimeFmt))

	total, err := UserMonthlyUsage(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if total != 30 { // 2 × (10+5), last-month and pending excluded
		t.Fatalf("monthly usage = %d, want 30", total)
	}
}

func TestUserMonthlyUsageBatch(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	a := mustUserID(t, db)
	b := mustUserID(t, db)
	thisMonth := monthStart(time.Now()).AddDate(0, 0, 5)

	id, _ := RecordUsage(db, a, "m", 10, 5)
	setCreatedAt(t, db, id, thisMonth.Format(sqliteTimeFmt))
	id, _ = RecordUsage(db, a, "m", 2, 0)
	setCreatedAt(t, db, id, thisMonth.Format(sqliteTimeFmt))
	id, _ = RecordUsage(db, b, "m", 7, 7)
	setCreatedAt(t, db, id, thisMonth.Format(sqliteTimeFmt))

	got, err := UserMonthlyUsageBatch(db, []int64{a, b})
	if err != nil {
		t.Fatal(err)
	}
	if got[a] != 17 || got[b] != 14 {
		t.Fatalf("batch = %v, want a=17 b=14", got)
	}
	if len(got) != 2 {
		t.Fatalf("batch returned %d entries, want 2", len(got))
	}
	// empty input → empty map, no error
	empty, err := UserMonthlyUsageBatch(db, nil)
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty batch = %v err=%v", empty, err)
	}
}

// TestEffectiveQuota: admin exempt; per-user override wins; else global
// default; missing/invalid global setting → unlimited.
func TestEffectiveQuota(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()

	adminID := mustUserID(t, db)
	u, _ := GetUserByID(db, adminID)
	u.IsAdmin = true
	if err := UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}

	uid := mustUserID(t, db)
	uu, _ := GetUserByID(db, uid)

	// no global setting, no override → unlimited
	if q, err := EffectiveQuota(db, uu); err != nil || q != 0 {
		t.Fatalf("default quota = %d err=%v, want 0 (unlimited)", q, err)
	}
	// admin always unlimited
	if q, err := EffectiveQuota(db, u); err != nil || q != 0 {
		t.Fatalf("admin quota = %d err=%v, want 0", q, err)
	}
	// global default
	if err := SetSetting(db, MonthlyQuotaSetting, "5000"); err != nil {
		t.Fatal(err)
	}
	if q, _ := EffectiveQuota(db, uu); q != 5000 {
		t.Fatalf("global default quota = %d, want 5000", q)
	}
	// invalid global value → unlimited
	if err := SetSetting(db, MonthlyQuotaSetting, "abc"); err != nil {
		t.Fatal(err)
	}
	if q, _ := EffectiveQuota(db, uu); q != 0 {
		t.Fatalf("invalid global quota = %d, want 0", q)
	}
	// per-user override wins over global
	if err := SetSetting(db, MonthlyQuotaSetting, "5000"); err != nil {
		t.Fatal(err)
	}
	qq := int64(300)
	uu.QuotaTokens = &qq
	if q, _ := EffectiveQuota(db, uu); q != 300 {
		t.Fatalf("override quota = %d, want 300", q)
	}
	// admin with explicit low quota is still unlimited
	uu2, _ := GetUserByID(db, adminID)
	qq = 1
	uu2.QuotaTokens = &qq
	if q, _ := EffectiveQuota(db, uu2); q != 0 {
		t.Fatalf("admin override quota = %d, want 0 (exempt)", q)
	}
}

// TestUsageAggregateUserJoinsUsername: group=user labels the username (from
// the users table), falling back to the numeric id for deleted users.
func TestUsageAggregateUserJoinsUsername(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid, err := CreateUser(db, &User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	rowID, err := RecordUsage(db, uid, "m", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAt(t, db, rowID, "2026-08-10 09:00:00")

	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "user")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Label != "alice" {
		t.Fatalf("user rows = %+v, want label alice", rows)
	}

	// date range + user group must not hit an ambiguous created_at (users
	// table also has created_at after the LEFT JOIN)
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local)
	to := time.Date(2026, 8, 31, 0, 0, 0, 0, time.Local)
	rows, err = UsageAggregate(db, from, to, "user")
	if err != nil {
		t.Fatalf("user group with date filter: %v", err)
	}
	if len(rows) != 1 || rows[0].Label != "alice" {
		t.Fatalf("user rows with range = %+v, want label alice", rows)
	}

	// deleted user falls back to the numeric id
	other, err := CreateUser(db, &User{Username: "ghost", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, other, "m", 2, 2); err != nil {
		t.Fatal(err)
	}
	if err := DeleteUser(db, other); err != nil {
		t.Fatal(err)
	}
	rows, err = UsageAggregate(db, time.Time{}, time.Time{}, "user")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range rows {
		if r.Label == "ghost" {
			found = true
		}
	}
	if found {
		t.Fatalf("deleted user still labelled by username: %+v", rows)
	}
}

// TestUsageAggregateZeroFill: group=day with from/to 区间内缺日填 0,
// 保证折线不跨缺日直连。
func TestUsageAggregateZeroFill(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	for _, ts := range []string{"2026-08-10 09:00:00", "2026-08-12 09:00:00"} {
		id, _ := RecordUsage(db, uid, "m", 10, 5)
		setCreatedAt(t, db, id, ts)
	}
	from := time.Date(2026, 8, 10, 0, 0, 0, 0, time.Local)
	to := time.Date(2026, 8, 12, 0, 0, 0, 0, time.Local)
	rows, err := UsageAggregate(db, from, to, "day")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 { // 8-10, 8-11(填0), 8-12
		t.Fatalf("zero-fill rows = %d, want 3 (8-10/8-11/8-12)", len(rows))
	}
	wantLabels := []string{"2026-08-10", "2026-08-11", "2026-08-12"}
	for i, w := range wantLabels {
		if rows[i].Label != w {
			t.Fatalf("row[%d].Label = %q, want %q", i, rows[i].Label, w)
		}
	}
	if rows[1].Requests != 0 {
		t.Fatalf("gap day requests = %d, want 0", rows[1].Requests)
	}
	if rows[0].Requests != 1 || rows[2].Requests != 1 {
		t.Fatalf("non-gap requests wrong: %+v", rows)
	}
}

// TestUsageAggregateWeekMonth: group=week/month 正确聚合并按期补齐。
func TestUsageAggregateWeekMonth(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	// 2026-08-10(周一)与 2026-08-17(下周一)分属两个周桶
	for _, ts := range []string{"2026-08-10 09:00:00", "2026-08-17 09:00:00", "2026-08-18 09:00:00"} {
		id, _ := RecordUsage(db, uid, "m", 10, 5)
		setCreatedAt(t, db, id, ts)
	}
	from := time.Date(2026, 8, 10, 0, 0, 0, 0, time.Local)
	to := time.Date(2026, 8, 20, 0, 0, 0, 0, time.Local)

	rows, err := UsageAggregate(db, from, to, "week")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 { // 周桶 2026-08-10(8-10), 2026-08-17(8-17+8-18)
		t.Fatalf("week rows = %d, want 2", len(rows))
	}
	if rows[0].Label != "2026-08-10" || rows[1].Label != "2026-08-17" {
		t.Fatalf("week labels wrong: %+v", rows)
	}
	if rows[0].Requests != 1 || rows[1].Requests != 2 {
		t.Fatalf("week aggregation wrong: %+v", rows)
	}

	fromM := time.Date(2026, 7, 1, 0, 0, 0, 0, time.Local)
	toM := time.Date(2026, 9, 15, 0, 0, 0, 0, time.Local)
	rows, err = UsageAggregate(db, fromM, toM, "month")
	if err != nil {
		t.Fatal(err)
	}
	// 7/8/9 三个月,7 月填 0
	if len(rows) != 3 {
		t.Fatalf("month rows = %d, want 3", len(rows))
	}
	if rows[0].Label != "2026-07" || rows[0].Requests != 0 {
		t.Fatalf("july should be zero-filled: %+v", rows[0])
	}
	if rows[1].Label != "2026-08" || rows[1].Requests != 3 {
		t.Fatalf("august rows = %+v", rows[1])
	}
}

// TestUsageAggregateKindSplit: embedding 行单独计入 embed_requests/embed_tokens。
func TestUsageAggregateKindSplit(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	if _, err := RecordUsage(db, uid, "m", 10, 5); err != nil { // chat
		t.Fatal(err)
	}
	if _, err := RecordUsageKind(db, uid, "embed-m", 30, 0, "embedding"); err != nil {
		t.Fatal(err)
	}
	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "day")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d", len(rows))
	}
	r := rows[0]
	if r.Requests != 2 || r.EmbedRequests != 1 {
		t.Fatalf("requests=%d embed_requests=%d, want 2/1", r.Requests, r.EmbedRequests)
	}
	if r.EmbedTokens != 30 || r.PromptTokens != 40 {
		t.Fatalf("embed_tokens=%d prompt_tokens=%d, want 30/40", r.EmbedTokens, r.PromptTokens)
	}
}

// TestUsageAggregateMonthOverflow: from 为月末(8/31)时月桶不得跳过 9 月
// (审计2026-E3 P1-2 回归)。
func TestUsageAggregateMonthOverflow(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	id, _ := RecordUsage(db, uid, "m", 10, 5)
	setCreatedAt(t, db, id, "2026-08-31 09:00:00")
	id, _ = RecordUsage(db, uid, "m", 20, 5)
	setCreatedAt(t, db, id, "2026-09-15 09:00:00")

	from := time.Date(2026, 8, 31, 0, 0, 0, 0, time.Local)
	to := time.Date(2026, 9, 15, 0, 0, 0, 0, time.Local)
	rows, err := UsageAggregate(db, from, to, "month")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("month rows = %d, want 2 (2026-08, 2026-09)", len(rows))
	}
	if rows[0].Label != "2026-08" || rows[1].Label != "2026-09" {
		t.Fatalf("month labels wrong: %+v", rows)
	}
	if rows[0].Requests != 1 || rows[1].Requests != 1 {
		t.Fatalf("month requests wrong: %+v", rows)
	}
}

// TestUsageAggregateUserFilter: username 过滤仅返回该用户。
func TestUsageAggregateUserFilter(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	a, err := CreateUser(db, &User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	b, err := CreateUser(db, &User{Username: "bob", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = RecordUsage(db, a, "m", 10, 5)
	_, _ = RecordUsage(db, b, "m", 99, 1)

	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "day", WithUsername("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].PromptTokens != 10 {
		t.Fatalf("filtered rows = %+v, want alice 10", rows)
	}

	// username 过滤 + group=user 组合:相关子查询不产生双 JOIN(审计2026-E3 P1-1)
	rows, err = UsageAggregate(db, time.Time{}, time.Time{}, "user", WithUsername("alice"))
	if err != nil {
		t.Fatalf("user group + username filter: %v", err)
	}
	if len(rows) != 1 || rows[0].Label != "alice" {
		t.Fatalf("user+filter rows = %+v, want [alice]", rows)
	}
}
