package serverauth

import (
	"database/sql"
	"errors"
	"fmt"
	"os"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// EnsureBootstrapAdmin creates the first admin from --bootstrap-admin and
// PICOAI_ADMIN_PASSWORD when no admin exists yet. It fails when the env
// password is missing (never prints or randomizes the password).
func EnsureBootstrapAdmin(db *sql.DB, username string) error {
	users, _, err := serverstore.ListUsers(db, 0, 100000)
	if err != nil {
		return err
	}
	for _, u := range users {
		if u.IsAdmin {
			return nil // admin exists; ignore
		}
	}
	password := os.Getenv("PICOAI_ADMIN_PASSWORD")
	if password == "" {
		return fmt.Errorf("PICOAI_ADMIN_PASSWORD environment variable is required to bootstrap admin %q", username)
	}
	_, err = serverstore.GetUserByUsername(db, username)
	if err == nil {
		return errors.New("bootstrap admin username already exists but is not an admin")
	}
	id, err := serverstore.CreateUserWithPassword(db, username, password)
	if err != nil {
		return err
	}
	u, err := serverstore.GetUserByID(db, id)
	if err != nil {
		return err
	}
	u.IsAdmin = true
	return serverstore.UpdateUser(db, u)
}
