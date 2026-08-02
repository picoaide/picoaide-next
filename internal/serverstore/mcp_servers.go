package serverstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// MCPServer is a marketplace MCP plugin row. Env/Headers values that are
// sensitive are AES-GCM encrypted ("enc:v1:" prefix) before storage.
type MCPServer struct {
	ID          int64
	Name        string
	Description string
	Transport   string
	Command     string
	Args        []string
	URL         string
	Env         map[string]string
	Headers     map[string]string
	Enabled     int
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// MCPConfigDownload is one row of the credential-fetch audit trail.
type MCPConfigDownload struct {
	ID        int64
	UserID    int64
	MCPID     int64
	CreatedAt time.Time
}

func scanMCPServer(row interface{ Scan(...any) error }) (*MCPServer, error) {
	var m MCPServer
	var args, env, headers, createdAt, updatedAt string
	if err := row.Scan(&m.ID, &m.Name, &m.Description, &m.Transport, &m.Command,
		&args, &m.URL, &env, &headers, &m.Enabled, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	m.Args = jsonStringSlice(args)
	m.Env = jsonStringMap(env)
	m.Headers = jsonStringMap(headers)
	m.CreatedAt = parseSQLTime(createdAt)
	m.UpdatedAt = parseSQLTime(updatedAt)
	return &m, nil
}

const mcpColumns = "id, name, description, transport, command, args, url, env, headers, enabled, created_at, updated_at"

// AddMCPServer inserts a plugin row and returns its id.
func AddMCPServer(db *sql.DB, m *MCPServer) (int64, error) {
	res, err := db.Exec(`INSERT INTO mcp_servers (name, description, transport, command, args, url, env, headers, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.Name, m.Description, m.Transport, m.Command, marshalJSON(m.Args),
		m.URL, marshalJSON(m.Env), marshalJSON(m.Headers), m.Enabled)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetMCPServer returns the plugin by id or ErrNotFound.
func GetMCPServer(db *sql.DB, id int64) (*MCPServer, error) {
	m, err := scanMCPServer(db.QueryRow(`SELECT `+mcpColumns+` FROM mcp_servers WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

// UpdateMCPServer updates all fields by id (including enabled for 下架);
// returns ErrNotFound.
func UpdateMCPServer(db *sql.DB, m *MCPServer) error {
	res, err := db.Exec(`UPDATE mcp_servers SET name=?, description=?, transport=?, command=?, args=?, url=?, env=?, headers=?, enabled=?, updated_at=datetime('now','localtime')
		WHERE id=?`,
		m.Name, m.Description, m.Transport, m.Command, marshalJSON(m.Args),
		m.URL, marshalJSON(m.Env), marshalJSON(m.Headers), m.Enabled, m.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteMCPServer removes the row; returns ErrNotFound if absent.
func DeleteMCPServer(db *sql.DB, id int64) error {
	res, err := db.Exec("DELETE FROM mcp_servers WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListMCPServers returns all plugins, filtered to enabled ones when enabledOnly.
func ListMCPServers(db *sql.DB, enabledOnly bool) ([]MCPServer, error) {
	q := `SELECT ` + mcpColumns + ` FROM mcp_servers`
	if enabledOnly {
		q += ` WHERE enabled = 1`
	}
	q += ` ORDER BY id`
	rows, err := db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MCPServer
	for rows.Next() {
		m, err := scanMCPServer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

// RecordDownload appends a credential-fetch audit row.
func RecordDownload(db *sql.DB, userID, mcpID int64) error {
	_, err := db.Exec("INSERT INTO mcp_config_downloads (user_id, mcp_id) VALUES (?, ?)", userID, mcpID)
	return err
}

// ListDownloads returns audit rows for a user within [since, until].
func ListDownloads(db *sql.DB, userID int64, since, until time.Time) ([]MCPConfigDownload, error) {
	rows, err := db.Query(`SELECT id, user_id, mcp_id, created_at FROM mcp_config_downloads
		WHERE user_id = ? AND created_at >= ? AND created_at <= ? ORDER BY id DESC`,
		userID, since.Format(sqlTimeFormat), until.Format(sqlTimeFormat))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MCPConfigDownload
	for rows.Next() {
		var d MCPConfigDownload
		var createdAt string
		if err := rows.Scan(&d.ID, &d.UserID, &d.MCPID, &createdAt); err != nil {
			return nil, err
		}
		d.CreatedAt = parseSQLTime(createdAt)
		out = append(out, d)
	}
	return out, rows.Err()
}

func marshalJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

func jsonStringSlice(s string) []string {
	if s == "" {
		return []string{}
	}
	var out []string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return []string{}
	}
	return out
}

func jsonStringMap(s string) map[string]string {
	if s == "" {
		return map[string]string{}
	}
	var out map[string]string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return map[string]string{}
	}
	return out
}
