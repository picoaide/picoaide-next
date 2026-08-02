package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/util"
)

type User struct {
	ID           int64
	Username     string
	DisplayName  string
	Email        string
	PasswordHash string
	Source       string
	IsAdmin      bool
	Status       int
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// CreateUserWithPassword creates a local user, hashing the plaintext password.
func CreateUserWithPassword(db *sql.DB, username, password string) (int64, error) {
	hash, err := util.HashPassword(password)
	if err != nil {
		return 0, err
	}
	return CreateUser(db, &User{Username: username, PasswordHash: hash, Source: "local", Status: 1})
}

// AuthenticateLocal verifies username/password against the users table.
// Returns ErrNotFound for unknown users or wrong password.
func AuthenticateLocal(db *sql.DB, username, password string) (User, error) {
	u, err := GetUserByUsername(db, username)
	if err != nil {
		return User{}, err
	}
	if u.Source != "local" || u.PasswordHash == "" {
		return User{}, ErrNotFound
	}
	if u.Status != 1 {
		return User{}, ErrNotFound
	}
	if !util.VerifyPassword(u.PasswordHash, password) {
		return User{}, ErrNotFound
	}
	return *u, nil
}

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	var isAdmin, status int
	var displayName, email, passwordHash sql.NullString
	var createdAt, updatedAt string
	if err := row.Scan(&u.ID, &u.Username, &displayName, &email, &passwordHash, &u.Source, &isAdmin, &status, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	u.CreatedAt = parseSQLTime(createdAt)
	u.UpdatedAt = parseSQLTime(updatedAt)
	u.DisplayName = displayName.String
	u.Email = email.String
	u.PasswordHash = passwordHash.String
	u.IsAdmin = isAdmin == 1
	u.Status = status
	return &u, nil
}

// CreateUser inserts a user row and returns its id.
func CreateUser(db *sql.DB, u *User) (int64, error) {
	res, err := db.Exec(`INSERT INTO users (username, display_name, email, password_hash, source, is_admin, status)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		u.Username, nullIfEmpty(u.DisplayName), nullIfEmpty(u.Email), nullIfEmpty(u.PasswordHash),
		u.Source, boolInt(u.IsAdmin), u.Status)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	return res.LastInsertId()
}

// GetUserByUsername returns the user or ErrNotFound.
func GetUserByUsername(db *sql.DB, username string) (*User, error) {
	row := db.QueryRow(`SELECT id, username, display_name, email, password_hash, source, is_admin, status, created_at, updated_at
		FROM users WHERE username = ?`, username)
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

func GetUserByID(db *sql.DB, id int64) (*User, error) {
	row := db.QueryRow(`SELECT id, username, display_name, email, password_hash, source, is_admin, status, created_at, updated_at
		FROM users WHERE id = ?`, id)
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// UpdateUser updates display_name/email/password_hash/is_admin/status.
func UpdateUser(db *sql.DB, u *User) error {
	res, err := db.Exec(`UPDATE users SET display_name=?, email=?, password_hash=?, is_admin=?, status=?, updated_at=datetime('now','localtime')
		WHERE id=?`,
		nullIfEmpty(u.DisplayName), nullIfEmpty(u.Email), nullIfEmpty(u.PasswordHash),
		boolInt(u.IsAdmin), u.Status, u.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListUsers returns a page of users and the total count.
func ListUsers(db *sql.DB, offset, limit int) ([]User, int64, error) {
	var total int64
	if err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.Query(`SELECT id, username, display_name, email, password_hash, source, is_admin, status, created_at, updated_at
		FROM users ORDER BY id LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		users = append(users, *u)
	}
	return users, total, rows.Err()
}

func isUniqueViolation(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "UNIQUE") || strings.Contains(err.Error(), "unique constraint"))
}

const sqlTimeFormat = "2006-01-02 15:04:05"

func parseSQLTime(s string) time.Time {
	for _, f := range []string{sqlTimeFormat, time.RFC3339} {
		if t, err := time.Parse(f, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// DeleteUser removes a user and all their FK-referenced rows
// (api_tokens, usage, admin_sessions, mcp_config_downloads, user_groups)
// in a single transaction so deletion never trips the FK constraint.
func DeleteUser(db *sql.DB, id int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range []string{
		"DELETE FROM api_tokens WHERE user_id = ?",
		"DELETE FROM usage WHERE user_id = ?",
		"DELETE FROM admin_sessions WHERE user_id = ?",
		"DELETE FROM mcp_config_downloads WHERE user_id = ?",
		"DELETE FROM user_groups WHERE user_id = ?",
	} {
		if _, err := tx.Exec(stmt, id); err != nil {
			return err
		}
	}
	res, err := tx.Exec("DELETE FROM users WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}
