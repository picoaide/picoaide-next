package serverstore

import (
	"database/sql"
	"time"
)

const sqliteTimeFmt = "2006-01-02 15:04:05"

// RecordUsage inserts a chat usage row and returns its id.
func RecordUsage(db *sql.DB, userID int64, model string, promptTokens, completionTokens int64) (int64, error) {
	return RecordUsageKind(db, userID, model, promptTokens, completionTokens, "chat")
}

// RecordUsageKind inserts a usage row with an explicit kind (chat | embedding).
// embedding 行的 0-token(上游省略 usage)是真实请求计数,不得被
// CleanupPendingUsage 当作流中断残留清除(审计2026-M16)。
func RecordUsageKind(db *sql.DB, userID int64, model string, promptTokens, completionTokens int64, kind string) (int64, error) {
	res, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind) VALUES (?, ?, ?, ?, ?)`,
		userID, model, promptTokens, completionTokens, kind)
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

// DeleteUsage removes a usage row. Used to drop pending rows that can never
// be backfilled (C-9: failed/aborted streams).
func DeleteUsage(db *sql.DB, id int64) error {
	_, err := db.Exec("DELETE FROM usage WHERE id = ?", id)
	return err
}

// CleanupPendingUsage deletes zero-token chat rows older than cutoff (stale
// pending rows left by interrupted streaming requests). Run at server startup.
func CleanupPendingUsage(db *sql.DB, cutoff time.Time) error {
	_, err := db.Exec(`DELETE FROM usage WHERE kind = 'chat' AND prompt_tokens = 0 AND completion_tokens = 0 AND created_at < ?`,
		cutoff.Format(sqliteTimeFmt))
	return err
}

// UsageAggregateRow is one aggregated usage row.
type UsageAggregateRow struct {
	Label            string `json:"label"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	Requests         int64  `json:"requests"`
}

// UsageAggregate aggregates usage by day | model | user between from/to
// (zero time means unbounded).按 user 分组时标签用用户名(JOIN users,
// 审计2026-L8),查无行时回退用户 ID。
func UsageAggregate(db *sql.DB, from, to time.Time, group string) ([]UsageAggregateRow, error) {
	var selectExpr, groupExpr string
	switch group {
	case "day":
		selectExpr, groupExpr = "date(created_at)", "date(created_at)"
	case "model":
		selectExpr, groupExpr = "model", "model"
	default:
		selectExpr = "COALESCE(u.username, CAST(usage.user_id AS TEXT))"
		groupExpr = "u.username, usage.user_id"
	}
	q := `SELECT ` + selectExpr + ` AS label,
		SUM(usage.prompt_tokens) AS pt, SUM(usage.completion_tokens) AS ct, COUNT(*) AS req
		FROM usage`
	if group != "day" && group != "model" {
		q += " LEFT JOIN users u ON u.id = usage.user_id"
	}
	q += " WHERE 1=1"
	var args []any
	if !from.IsZero() {
		q += " AND created_at >= ?"
		args = append(args, from.Format("2006-01-02"))
	}
	if !to.IsZero() {
		q += " AND created_at < ?"
		args = append(args, to.Add(24*time.Hour).Format("2006-01-02"))
	}
	q += " GROUP BY " + groupExpr + " ORDER BY label"
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageAggregateRow{}
	for rows.Next() {
		var r UsageAggregateRow
		if err := rows.Scan(&r.Label, &r.PromptTokens, &r.CompletionTokens, &r.Requests); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
