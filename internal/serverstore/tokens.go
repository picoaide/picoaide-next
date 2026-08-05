package serverstore

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

// TokenHash returns the SHA-256 hex digest of a raw token.
func TokenHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// CreateToken stores a hashed token with expiresAt (UTC) and returns its id.
func CreateToken(db *sql.DB, userID int64, raw string, expiresAt time.Time) (int64, error) {
	res, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
		userID, TokenHash(raw), expiresAt.UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetTokenByHash returns the token row by hashed value.
func GetTokenByHash(db *sql.DB, hash string) (*Token, error) {
	var t Token
	var expiresAt, lastUsed sql.NullString
	err := db.QueryRow(`SELECT id, user_id, token_hash, name, created_at, expires_at, last_used_at, revoked
		FROM api_tokens WHERE token_hash = ?`, hash).
		Scan(&t.ID, &t.UserID, &t.TokenHash, &t.Name, &t.CreatedAt, &expiresAt, &lastUsed, &t.Revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt.String)
	if lastUsed.Valid {
		t.LastUsedAt, _ = time.Parse(time.RFC3339, lastUsed.String)
	}
	return &t, nil
}

// RevokeToken revokes a token by hash.
func RevokeToken(db *sql.DB, hash string) error {
	res, err := db.Exec("UPDATE api_tokens SET revoked = 1 WHERE token_hash = ?", hash)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

type Token struct {
	ID         int64
	UserID     int64
	TokenHash  string
	Name       string
	CreatedAt  string
	ExpiresAt  time.Time
	LastUsedAt time.Time
	Revoked    int
}
