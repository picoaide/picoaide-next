package serverstore

import "database/sql"

// queryer matches both *sql.DB and *sql.Tx.
type queryer interface {
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

// GetOrCreateGroup returns a group id by name, creating it if missing.
func GetOrCreateGroup(db queryer, name string) (int64, error) {
	var id int64
	err := db.QueryRow("SELECT id FROM groups WHERE name = ?", name).Scan(&id)
	if err == sql.ErrNoRows {
		res, err := db.Exec("INSERT INTO groups (name) VALUES (?)", name)
		if err != nil {
			// concurrent insert; re-read
			if err2 := db.QueryRow("SELECT id FROM groups WHERE name = ?", name).Scan(&id); err2 == nil {
				return id, nil
			}
			return 0, err
		}
		return res.LastInsertId()
	}
	return id, err
}

// UserGroups returns the group names for a user.
func UserGroups(db *sql.DB, userID int64) ([]string, error) {
	rows, err := db.Query(`SELECT g.name FROM groups g
		JOIN user_groups ug ON ug.group_id = g.id
		WHERE ug.user_id = ? ORDER BY g.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// SyncUserGroups replaces the user's group membership with the given names.
func SyncUserGroups(db *sql.DB, userID int64, names []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM user_groups WHERE user_id = ?", userID); err != nil {
		return err
	}
	for _, n := range names {
		gid, err := GetOrCreateGroup(tx, n)
		if err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)", userID, gid); err != nil {
			return err
		}
	}
	return tx.Commit()
}
