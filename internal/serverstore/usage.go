package serverstore

import (
	"database/sql"
	"fmt"
	"time"
)

// UsageDay is one day of aggregated usage for a user.
type UsageDay struct {
	Day              string
	PromptTokens     int64
	CompletionTokens int64
}

// TotalUsage is a sum of tokens over a time window.
type TotalUsage struct {
	PromptTokens     int64
	CompletionTokens int64
}

const sqliteTimeFmt = "2006-01-02 15:04:05"

// RecordUsage inserts a usage row and returns its id.
func RecordUsage(db *sql.DB, userID int64, model string, promptTokens, completionTokens int64) (int64, error) {
	res, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?)`,
		userID, model, promptTokens, completionTokens)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateUsageTokens backfills token counts on an existing usage row (pending row).
func UpdateUsageTokens(db *sql.DB, id, promptTokens, completionTokens int64) error {
	_, err := db.Exec("UPDATE usage SET prompt_tokens = ?, completion_tokens = ? WHERE id = ?",
		promptTokens, completionTokens, id)
	return err
}

// UsageByUser returns per-day aggregated usage within [since, until).
func UsageByUser(db *sql.DB, userID int64, since, until time.Time) ([]UsageDay, error) {
	rows, err := db.Query(`SELECT date(created_at) AS day, SUM(prompt_tokens), SUM(completion_tokens)
		FROM usage WHERE user_id = ? AND created_at >= ? AND created_at < ?
		GROUP BY day ORDER BY day`, userID, since.Format(sqliteTimeFmt), until.Format(sqliteTimeFmt))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var days []UsageDay
	for rows.Next() {
		var d UsageDay
		if err := rows.Scan(&d.Day, &d.PromptTokens, &d.CompletionTokens); err != nil {
			return nil, err
		}
		days = append(days, d)
	}
	return days, rows.Err()
}

// UsageTotal sums tokens within [since, until).
func UsageTotal(db *sql.DB, since, until time.Time) (TotalUsage, error) {
	var t TotalUsage
	err := db.QueryRow(`SELECT COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0)
		FROM usage WHERE created_at >= ? AND created_at < ?`,
		since.Format(sqliteTimeFmt), until.Format(sqliteTimeFmt)).Scan(&t.PromptTokens, &t.CompletionTokens)
	if err != nil {
		return TotalUsage{}, fmt.Errorf("usage total: %w", err)
	}
	return t, nil
}

// CleanupPendingUsage deletes zero-token rows older than cutoff (stale pending
// rows left by interrupted streaming requests). Run at server startup.
func CleanupPendingUsage(db *sql.DB, cutoff time.Time) error {
	_, err := db.Exec(`DELETE FROM usage WHERE prompt_tokens = 0 AND completion_tokens = 0 AND created_at < ?`,
		cutoff.Format(sqliteTimeFmt))
	return err
}
