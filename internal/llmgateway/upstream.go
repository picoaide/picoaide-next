package llmgateway

import (
	"database/sql"
	"encoding/json"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// DecryptSecret decrypts an upstream API key. Identity default; the AES-GCM
// master-key wiring is installed by the orchestrator (task 1.12).
var DecryptSecret = func(s string) (string, error) { return s, nil }

// Upstream is an enabled OpenAI-compatible provider.
type Upstream struct {
	Name    string
	BaseURL string
	APIKey  string
	Models  []string
}

// LoadUpstreams returns all enabled providers with their model lists.
func LoadUpstreams(db *sql.DB) ([]Upstream, error) {
	rows, err := db.Query(`SELECT name, base_url, api_key_enc, models FROM gateway_providers WHERE enabled = 1 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ups []Upstream
	for rows.Next() {
		var u Upstream
		var key, modelsJSON string
		if err := rows.Scan(&u.Name, &u.BaseURL, &key, &modelsJSON); err != nil {
			return nil, err
		}
		key, err := DecryptSecret(key)
		if err != nil {
			return nil, err
		}
		u.APIKey = key
		if err := json.Unmarshal([]byte(modelsJSON), &u.Models); err != nil {
			return nil, err
		}
		ups = append(ups, u)
	}
	return ups, rows.Err()
}

// MatchModel finds the enabled upstream serving modelName, or ErrNotFound.
func MatchModel(db *sql.DB, modelName string) (*Upstream, error) {
	ups, err := LoadUpstreams(db)
	if err != nil {
		return nil, err
	}
	for i := range ups {
		for _, m := range ups[i].Models {
			if m == modelName {
				return &ups[i], nil
			}
		}
	}
	return nil, serverstore.ErrNotFound
}
