package serverstore

import (
	"database/sql"
	"strconv"
	"strings"
	"time"
)

const sqliteTimeFmt = "2006-01-02 15:04:05"

// MonthlyQuotaSetting is the settings key for the default per-user monthly
// traffic quota in tokens (absent / "0" = unlimited).
const MonthlyQuotaSetting = "usage.monthly_quota"

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

// DeleteUsage removes a usage row. Used to drop pending rows that can never
// be backfilled (C-9: failed/aborted streams).
func DeleteUsage(db *sql.DB, id int64) error {
	_, err := db.Exec("DELETE FROM usage WHERE id = ?", id)
	return err
}

// CleanupPendingUsage deletes zero-token rows older than cutoff (stale pending
// rows left by interrupted streaming requests). Run at server startup.
func CleanupPendingUsage(db *sql.DB, cutoff time.Time) error {
	_, err := db.Exec(`DELETE FROM usage WHERE prompt_tokens = 0 AND completion_tokens = 0 AND created_at < ?`,
		cutoff.Format(sqliteTimeFmt))
	return err
}

// monthStart returns the first instant of the current calendar month in the
// same location SQLite stores created_at in (localtime).
func monthStart(now time.Time) time.Time {
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
}

// UserMonthlyUsage returns the user's total tokens used in the current
// calendar month. Zero-token pending rows contribute nothing, so interrupted
// streams never inflate the counter.
func UserMonthlyUsage(db *sql.DB, userID int64) (int64, error) {
	var total int64
	err := db.QueryRow(`SELECT COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0)
		FROM usage WHERE user_id = ? AND created_at >= ?`,
		userID, monthStart(time.Now()).Format(sqliteTimeFmt)).Scan(&total)
	return total, err
}

// UserMonthlyUsageBatch returns a map of user_id → tokens used this calendar
// month for a bounded set of users (one query, no N+1).
func UserMonthlyUsageBatch(db *sql.DB, userIDs []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if len(userIDs) == 0 {
		return out, nil
	}
	placeholders := strings.Repeat("?,", len(userIDs))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(userIDs)+1)
	args = append(args, monthStart(time.Now()).Format(sqliteTimeFmt))
	for _, id := range userIDs {
		args = append(args, id)
	}
	rows, err := db.Query(`SELECT user_id, COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0) AS t
		FROM usage WHERE created_at >= ? AND user_id IN (`+placeholders+`) GROUP BY user_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid, t int64
		if err := rows.Scan(&uid, &t); err != nil {
			return nil, err
		}
		out[uid] = t
	}
	return out, rows.Err()
}

// EffectiveQuota returns a user's monthly traffic quota in tokens: a per-user
// override wins, otherwise the global default (settings usage.monthly_quota).
// 0 = unlimited. Admins are always unlimited.
func EffectiveQuota(db *sql.DB, user *User) (int64, error) {
	if user.IsAdmin {
		return 0, nil
	}
	if user.QuotaTokens != nil {
		return *user.QuotaTokens, nil
	}
	v, ok, err := GetSetting(db, MonthlyQuotaSetting)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		return 0, nil
	}
	return int64(n), nil
}

// UsageAggregateRow is one aggregated usage row.
type UsageAggregateRow struct {
	Label            string `json:"label"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	Requests         int64  `json:"requests"`
}

// UsageAggregate aggregates usage by day | model | user between from/to
// (zero time means unbounded). The user group joins users so the label is the
// username (falling back to the numeric id for deleted users).
func UsageAggregate(db *sql.DB, from, to time.Time, group string) ([]UsageAggregateRow, error) {
	var selectExpr, groupExpr string
	join := ""
	switch group {
	case "day":
		selectExpr, groupExpr = "date(usage.created_at)", "date(usage.created_at)"
	case "model":
		selectExpr, groupExpr = "usage.model", "usage.model"
	default:
		join = " LEFT JOIN users u ON u.id = usage.user_id"
		selectExpr, groupExpr = "COALESCE(u.username, CAST(usage.user_id AS TEXT))", "usage.user_id"
	}
	q := `SELECT ` + selectExpr + ` AS label,
		SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct, COUNT(*) AS req
		FROM usage` + join + ` WHERE 1=1`
	var args []any
	if !from.IsZero() {
		q += " AND usage.created_at >= ?"
		args = append(args, from.Format("2006-01-02"))
	}
	if !to.IsZero() {
		q += " AND usage.created_at < ?"
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
