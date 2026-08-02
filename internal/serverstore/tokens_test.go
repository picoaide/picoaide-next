package serverstore

import (
	"errors"
	"testing"
	"time"
)

func TestTokens(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "tokuser", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}

	id, err := CreateToken(db, uid, "raw-token-abc", time.Now().Add(90*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	got, err := GetTokenByHash(db, TokenHash("raw-token-abc"))
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != id || got.UserID != uid || got.Revoked != 0 || got.ExpiresAt.IsZero() {
		t.Fatalf("token mismatch: %+v", got)
	}

	// list
	list, err := TokenForUser(db, uid)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %v", list, err)
	}

	// revoke
	if err := RevokeToken(db, TokenHash("raw-token-abc")); err != nil {
		t.Fatal(err)
	}
	got2, _ := GetTokenByHash(db, TokenHash("raw-token-abc"))
	if got2.Revoked != 1 {
		t.Fatal("not revoked")
	}
	list2, _ := TokenForUser(db, uid)
	if len(list2) != 0 {
		t.Fatal("revoked token still listed")
	}

	// expired detection: token with past expiry
	if _, err := CreateToken(db, uid, "expired-token", time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	exp, err := GetTokenByHash(db, TokenHash("expired-token"))
	if err != nil {
		t.Fatal(err)
	}
	if !exp.ExpiresAt.Before(time.Now()) {
		t.Fatal("expired token should be before now")
	}

	if err := CleanupExpiredTokens(db); err != nil {
		t.Fatal(err)
	}
	if _, err := GetTokenByHash(db, TokenHash("expired-token")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cleanup: want ErrNotFound got %v", err)
	}
}
