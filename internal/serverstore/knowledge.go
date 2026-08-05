package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// KBFolder is a knowledge base folder.
type KBFolder struct {
	ID        int64
	Name      string
	ParentID  int64
	CreatedAt time.Time
}

// KBDocument is a knowledge base document.
type KBDocument struct {
	ID          int64
	FolderID    int64
	Title       string
	Content     string
	ContentType string
	Size        int64
	Source      string
	CreatedBy   string
	CreatedAt   time.Time
}

// KBAuditLog is one knowledge base audit entry.
type KBAuditLog struct {
	ID        int64
	Username  string
	Action    string
	Detail    string
	CreatedAt time.Time
}

// CreateKBFolder creates a folder (parentID 0 = root) and returns its id.
func CreateKBFolder(db *sql.DB, name string, parentID int64) (int64, error) {
	res, err := db.Exec("INSERT INTO kb_folders (name, parent_id) VALUES (?, ?)", name, parentID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListKBFolders returns all folders ordered by id.
func ListKBFolders(db *sql.DB) ([]KBFolder, error) {
	rows, err := db.Query("SELECT id, name, parent_id, created_at FROM kb_folders ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KBFolder
	for rows.Next() {
		var f KBFolder
		var created string
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID, &created); err != nil {
			return nil, err
		}
		f.CreatedAt = parseSQLTime(created)
		out = append(out, f)
	}
	return out, rows.Err()
}

// CreateKBDocument inserts a document and returns its id. size 0 means
// derive from content length. FTS index is synced by trigger kb_ai.
func CreateKBDocument(db *sql.DB, folderID int64, title, content, contentType string, size int64, source, createdBy string) (int64, error) {
	if size == 0 {
		size = int64(len(content))
	}
	res, err := db.Exec(`INSERT INTO kb_documents (folder_id, title, content, content_type, size, source, created_by)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, folderID, title, content, contentType, size, source, createdBy)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetKBDocument returns a document or ErrNotFound.
func GetKBDocument(db *sql.DB, id int64) (*KBDocument, error) {
	row := db.QueryRow(`SELECT id, folder_id, title, content, content_type, size, source, created_by, created_at
		FROM kb_documents WHERE id = ?`, id)
	var d KBDocument
	var created string
	err := row.Scan(&d.ID, &d.FolderID, &d.Title, &d.Content, &d.ContentType, &d.Size, &d.Source, &d.CreatedBy, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	d.CreatedAt = parseSQLTime(created)
	return &d, nil
}

// DeleteKBDocument removes a document (FTS row removed by trigger kb_ad).
func DeleteKBDocument(db *sql.DB, id int64) error {
	res, err := db.Exec("DELETE FROM kb_documents WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// GrantFolderUser grants folder access to a username (idempotent).
func GrantFolderUser(db *sql.DB, folderID int64, username string) error {
	_, err := db.Exec("INSERT OR IGNORE INTO kb_folder_users (folder_id, username) VALUES (?, ?)", folderID, username)
	return err
}

// GrantFolderGroup grants folder access to a group by name (idempotent).
func GrantFolderGroup(db *sql.DB, folderID int64, groupName string) error {
	gid, err := GetOrCreateGroup(db, groupName)
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT OR IGNORE INTO kb_folder_groups (folder_id, group_id) VALUES (?, ?)", folderID, gid)
	return err
}

// RevokeFolderUser removes a username grant (idempotent). Permission checks
// run at query time, so revoking takes effect immediately.
func RevokeFolderUser(db *sql.DB, folderID int64, username string) error {
	_, err := db.Exec("DELETE FROM kb_folder_users WHERE folder_id = ? AND username = ?", folderID, username)
	return err
}

// RevokeFolderGroup removes a group grant by name (idempotent).
func RevokeFolderGroup(db *sql.DB, folderID int64, groupName string) error {
	_, err := db.Exec("DELETE FROM kb_folder_groups WHERE folder_id = ? AND group_id = (SELECT id FROM groups WHERE name = ?)", folderID, groupName)
	return err
}

// ListKBFolderGrants returns usernames and group names granted on a folder.
func ListKBFolderGrants(db *sql.DB, folderID int64) (users, groups []string, err error) {
	rows, err := db.Query("SELECT username FROM kb_folder_users WHERE folder_id = ? ORDER BY username", folderID)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			rows.Close()
			return nil, nil, err
		}
		users = append(users, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	rows, err = db.Query(`SELECT g.name FROM kb_folder_groups kfg JOIN groups g ON g.id = kfg.group_id
		WHERE kfg.folder_id = ? ORDER BY g.name`, folderID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var g string
		if err := rows.Scan(&g); err != nil {
			return nil, nil, err
		}
		groups = append(groups, g)
	}
	return users, groups, rows.Err()
}

// UpdateKBDocument overwrites title/content/content_type and recomputes size.
// The FTS index is synced by trigger kb_au; ErrNotFound when id is missing.
func UpdateKBDocument(db *sql.DB, id int64, title, content, contentType string) error {
	res, err := db.Exec(`UPDATE kb_documents SET title = ?, content = ?, content_type = ?, size = ?
		WHERE id = ?`, title, content, contentType, len(content), id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetAccessibleFolderIDs returns folder ids the user can access: direct user
// grants, grants through the given groups, and always folder 0 (global root).
func GetAccessibleFolderIDs(db *sql.DB, username string, groups []string) ([]int64, error) {
	var sb strings.Builder
	sb.WriteString("SELECT folder_id FROM kb_folder_users WHERE username = ? UNION SELECT 0")
	args := []any{username}
	if len(groups) > 0 {
		sb.WriteString(" UNION SELECT folder_id FROM kb_folder_groups WHERE group_id IN (SELECT id FROM groups WHERE name IN (")
		for i, g := range groups {
			if i > 0 {
				sb.WriteString(",")
			}
			sb.WriteString("?")
			args = append(args, g)
		}
		sb.WriteString("))")
	}
	rows, err := db.Query("SELECT DISTINCT folder_id FROM ("+sb.String()+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// AuditLog appends a knowledge base audit entry.
func AuditLog(db *sql.DB, username, action, detail string) error {
	_, err := db.Exec("INSERT INTO kb_audit_logs (username, action, detail) VALUES (?, ?, ?)", username, action, detail)
	return err
}

// ListAuditLogs returns the most recent audit entries (limit <= 0: 50).
func ListAuditLogs(db *sql.DB, limit int) ([]KBAuditLog, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := db.Query("SELECT id, username, action, detail, created_at FROM kb_audit_logs ORDER BY id DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KBAuditLog
	for rows.Next() {
		var l KBAuditLog
		var created string
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &created); err != nil {
			return nil, err
		}
		l.CreatedAt = parseSQLTime(created)
		out = append(out, l)
	}
	return out, rows.Err()
}

// ListKBDocuments returns documents in a folder ordered by id desc.
func ListKBDocuments(db *sql.DB, folderID int64) ([]KBDocument, error) {
	rows, err := db.Query(`SELECT id, folder_id, title, content, content_type, size, source, created_by, created_at
		FROM kb_documents WHERE folder_id = ? ORDER BY id DESC`, folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KBDocument
	for rows.Next() {
		var d KBDocument
		var createdAt string
		if err := rows.Scan(&d.ID, &d.FolderID, &d.Title, &d.Content, &d.ContentType, &d.Size, &d.Source, &d.CreatedBy, &createdAt); err != nil {
			return nil, err
		}
		d.CreatedAt = parseSQLTime(createdAt)
		out = append(out, d)
	}
	return out, rows.Err()
}
