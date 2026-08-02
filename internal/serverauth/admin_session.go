package serverauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// AdminSessionTTL is the admin web session lifetime.
const AdminSessionTTL = 24 * time.Hour

// CSRF window is one hour; tokens from the previous window still verify.
const csrfWindow = time.Hour

type AdminSession struct {
	ID        string
	UserID    int64
	CSRFKey   string
	ExpiresAt time.Time
}

func newSessionID() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// CreateAdminSession stores a session and returns its id and a CSRF token.
func CreateAdminSession(db *sql.DB, userID int64) (*AdminSession, string, error) {
	id, err := newSessionID()
	if err != nil {
		return nil, "", err
	}
	csrfKey, err := newSessionID()
	if err != nil {
		return nil, "", err
	}
	s := &AdminSession{ID: id, UserID: userID, CSRFKey: csrfKey, ExpiresAt: time.Now().Add(AdminSessionTTL)}
	if _, err := db.Exec(`INSERT INTO admin_sessions (id, user_id, csrf_key, expires_at) VALUES (?, ?, ?, ?)`,
		id, userID, csrfKey, s.ExpiresAt.UTC().Format(time.RFC3339)); err != nil {
		return nil, "", err
	}
	return s, IssueCSRF(csrfKey, time.Now()), nil
}

// GetAdminSession loads a session row.
func GetAdminSession(db *sql.DB, id string) (*AdminSession, error) {
	var s AdminSession
	var expiresAt string
	err := db.QueryRow(`SELECT id, user_id, csrf_key, expires_at FROM admin_sessions WHERE id = ?`, id).
		Scan(&s.ID, &s.UserID, &s.CSRFKey, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, serverstore.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	s.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
	return &s, nil
}

// DeleteAdminSession removes a session.
func DeleteAdminSession(db *sql.DB, id string) error {
	_, err := db.Exec("DELETE FROM admin_sessions WHERE id = ?", id)
	return err
}

// ValidateAdminSession checks expiry and that the user is an active admin.
func ValidateAdminSession(db *sql.DB, id string) (*serverstore.User, error) {
	s, err := GetAdminSession(db, id)
	if err != nil {
		return nil, err
	}
	if time.Now().After(s.ExpiresAt) {
		return nil, errors.New("session expired")
	}
	u, err := serverstore.GetUserByID(db, s.UserID)
	if err != nil {
		return nil, err
	}
	if !u.IsAdmin || u.Status != 1 {
		return nil, errors.New("not an active admin")
	}
	return u, nil
}

// IssueCSRF produces the HMAC-SHA256 token for the given time's window.
func IssueCSRF(key string, at time.Time) string {
	window := strconv.FormatInt(at.UTC().Truncate(csrfWindow).Unix(), 10)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(window))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyCSRF accepts tokens from the current or previous window.
func VerifyCSRF(key, token string, at time.Time) bool {
	if token == "" {
		return false
	}
	for _, w := range []time.Time{at, at.Add(-csrfWindow)} {
		if hmac.Equal([]byte(IssueCSRF(key, w)), []byte(token)) {
			return true
		}
	}
	return false
}
