package serverstore

import (
	"errors"
	"testing"
	"time"
)

func TestUsers(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := CreateUser(db, &User{Username: "alice", DisplayName: "Alice", Source: "local", IsAdmin: true, Status: 1})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if id == 0 {
		t.Fatal("id = 0")
	}

	// duplicate username
	if _, err := CreateUser(db, &User{Username: "alice", Source: "local"}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("want ErrDuplicate, got %v", err)
	}

	u, err := GetUserByUsername(db, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if u.Username != "alice" || u.DisplayName != "Alice" || !u.IsAdmin || u.Status != 1 {
		t.Fatalf("user mismatch: %+v", u)
	}
	if u.CreatedAt.IsZero() {
		t.Fatal("created_at not parsed")
	}

	// update
	u.DisplayName = "Alice2"
	u.Status = 0
	if err := UpdateUser(db, u); err != nil {
		t.Fatalf("UpdateUser: %v", err)
	}
	u2, _ := GetUserByUsername(db, "alice")
	if u2.DisplayName != "Alice2" || u2.Status != 0 {
		t.Fatalf("update not applied: %+v", u2)
	}

	// not found
	if _, err := GetUserByUsername(db, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	// pagination
	for i := 0; i < 5; i++ {
		CreateUser(db, &User{Username: "u" + string(rune('a'+i)), Source: "local"})
	}
	users, total, err := ListUsers(db, 0, 3, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 3 || total != 6 {
		t.Fatalf("list: len=%d total=%d", len(users), total)
	}

	// search filter
	users, total, err = ListUsers(db, 0, 20, "ali")
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || users[0].Username != "alice" {
		t.Fatalf("search: total=%d users=%+v", total, users)
	}
}

func TestAuthenticateLocal(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateUserWithPassword(db, "bob", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, err := GetUserByUsername(db, "bob")
	if err != nil {
		t.Fatal(err)
	}
	if u.PasswordHash == "" || u.PasswordHash == "pw123456" {
		t.Fatal("password not hashed")
	}
	if _, err := AuthenticateLocal(db, "bob", "pw123456"); err != nil {
		t.Fatalf("correct password rejected: %v", err)
	}
	if _, err := AuthenticateLocal(db, "bob", "bad"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong password: want ErrNotFound got %v", err)
	}
	if _, err := AuthenticateLocal(db, "nobody", "pw123456"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user: want ErrNotFound got %v", err)
	}
}

func TestDeleteUserWithReferencedRows(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := CreateUserWithPassword(db, "carol", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	// 一个登录用户必然持有:api_token、usage、admin_session、mcp_config_downloads、user_groups
	if _, err := CreateToken(db, id, "raw-token", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, id, "m", 1, 2); err != nil {
		t.Fatal(err)
	}
	adminSessID := "session-" + time.Now().Format("150405")
	if _, err := db.Exec(`INSERT INTO admin_sessions (id, user_id, csrf_key, expires_at) VALUES (?, ?, ?, ?)`,
		adminSessID, id, "csrf", time.Now().Add(time.Hour).UTC().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	mcpID, err := AddMCPServer(db, &MCPServer{Name: "mcp1", Transport: "stdio"})
	if err != nil {
		t.Fatal(err)
	}
	if err := RecordDownload(db, id, mcpID); err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, id, []string{"g1"}); err != nil {
		t.Fatal(err)
	}

	if err := DeleteUser(db, id); err != nil {
		t.Fatalf("DeleteUser with referenced rows failed: %v", err)
	}
	// 用户及其全部关联行都应消失
	if _, err := GetUserByID(db, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("user still present: %v", err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM api_tokens WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tokens left: %d err=%v", n, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("usage left: %d err=%v", n, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM admin_sessions WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("sessions left: %d err=%v", n, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM mcp_config_downloads WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("downloads left: %d err=%v", n, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM user_groups WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("user_groups left: %d err=%v", n, err)
	}
}

func TestSettings(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	if _, ok, err := GetSetting(db, "a"); err != nil || ok {
		t.Fatalf("missing key: ok=%v err=%v", ok, err)
	}
	if err := SetSetting(db, "a", "1"); err != nil {
		t.Fatal(err)
	}
	// overwrite
	if err := SetSetting(db, "a", "2"); err != nil {
		t.Fatal(err)
	}
	v, ok, err := GetSetting(db, "a")
	if err != nil || !ok || v != "2" {
		t.Fatalf("get: %q ok=%v err=%v", v, ok, err)
	}
	if err := SetSetting(db, "b", "x"); err != nil {
		t.Fatal(err)
	}
	all, err := GetAllSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	if all["a"] != "2" || all["b"] != "x" || len(all) != 2 {
		t.Fatalf("all: %v", all)
	}
}
