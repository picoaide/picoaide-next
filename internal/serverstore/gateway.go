package serverstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type GatewayProvider struct {
	ID        int64
	Name      string
	BaseURL   string
	APIKeyEnc string
	Models    []string
	Enabled   int
}

type Model struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	ProviderID    int64  `json:"provider_id"`
	DisplayName   string `json:"display_name"`
	DefaultParams string `json:"default_params"`
}

func scanProvider(scan interface{ Scan(...any) error }) (*GatewayProvider, error) {
	var p GatewayProvider
	var models string
	if err := scan.Scan(&p.ID, &p.Name, &p.BaseURL, &p.APIKeyEnc, &models, &p.Enabled); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(models), &p.Models)
	return &p, nil
}

// ListGatewayProviders returns all providers.
func ListGatewayProviders(db *sql.DB) ([]GatewayProvider, error) {
	rows, err := db.Query(`SELECT id, name, base_url, api_key_enc, models, enabled
		FROM gateway_providers ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GatewayProvider
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// GetGatewayProvider loads one provider.
func GetGatewayProvider(db *sql.DB, id int64) (*GatewayProvider, error) {
	row := db.QueryRow(`SELECT id, name, base_url, api_key_enc, models, enabled
		FROM gateway_providers WHERE id = ?`, id)
	p, err := scanProvider(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// AddGatewayProvider inserts a provider; name conflicts return ErrDuplicate.
func AddGatewayProvider(db *sql.DB, p *GatewayProvider) (int64, error) {
	modelsJSON, _ := json.Marshal(p.Models)
	res, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled)
		VALUES (?, ?, ?, ?, ?)`, p.Name, p.BaseURL, p.APIKeyEnc, string(modelsJSON), p.Enabled)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	p.ID, _ = res.LastInsertId()
	return p.ID, nil
}

// UpdateGatewayProvider updates all fields.
func UpdateGatewayProvider(db *sql.DB, p *GatewayProvider) error {
	modelsJSON, _ := json.Marshal(p.Models)
	res, err := db.Exec(`UPDATE gateway_providers SET name=?, base_url=?, api_key_enc=?, models=?, enabled=?
		WHERE id=?`, p.Name, p.BaseURL, p.APIKeyEnc, string(modelsJSON), p.Enabled, p.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteGatewayProvider removes a provider (and its models).
func DeleteGatewayProvider(db *sql.DB, id int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM models WHERE provider_id = ?", id); err != nil {
		return err
	}
	res, err := tx.Exec("DELETE FROM gateway_providers WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// SyncProviderModels replaces the models table rows for a provider so it
// mirrors the provider's models JSON list. This keeps a single source of
// truth: the provider's model list is the model list the client sees.
func SyncProviderModels(db *sql.DB, providerID int64, names []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM models WHERE provider_id = ?", providerID); err != nil {
		return err
	}
	for _, name := range names {
		if _, err := tx.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES (?, ?, ?)`,
			name, providerID, name); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func scanModel(scan interface{ Scan(...any) error }) (*Model, error) {
	var m Model
	if err := scan.Scan(&m.ID, &m.Name, &m.ProviderID, &m.DisplayName, &m.DefaultParams); err != nil {
		return nil, err
	}
	return &m, nil
}

// GetModel loads a model by id.
func GetModel(db *sql.DB, id int64) (*Model, error) {
	row := db.QueryRow(`SELECT id, name, provider_id, display_name, default_params
		FROM models WHERE id = ?`, id)
	m, err := scanModel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

// AddModel inserts a model row.
func AddModel(db *sql.DB, m *Model) (int64, error) {
	if m.DefaultParams == "" {
		m.DefaultParams = "{}"
	}
	res, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, default_params)
		VALUES (?, ?, ?, ?)`, m.Name, m.ProviderID, m.DisplayName, m.DefaultParams)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	m.ID, _ = res.LastInsertId()
	return m.ID, nil
}

// UpdateModel updates a model row.
func UpdateModel(db *sql.DB, m *Model) error {
	res, err := db.Exec(`UPDATE models SET name=?, provider_id=?, display_name=?, default_params=?
		WHERE id=?`, m.Name, m.ProviderID, m.DisplayName, m.DefaultParams, m.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteModel removes a model.
func DeleteModel(db *sql.DB, id int64) error {
	res, err := db.Exec("DELETE FROM models WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
