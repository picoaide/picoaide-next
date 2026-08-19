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

// MonthlyMoneyQuotaSetting is the settings key for the default per-user
// monthly traffic quota in yuan (absent / "0" = unlimited).
const MonthlyMoneyQuotaSetting = "usage.monthly_quota_money"

// costOf computes the yuan cost for a usage row from model pricing
// (yuan per 1M tokens). Unpriced models (0,0) yield 0 cost.
func costOf(promptTokens, completionTokens int64, inputPer1M, outputPer1M float64) float64 {
	return float64(promptTokens)/1e6*inputPer1M + float64(completionTokens)/1e6*outputPer1M
}

// RecordUsage inserts a chat usage row and returns its id.
func RecordUsage(db *sql.DB, userID int64, model string, promptTokens, completionTokens int64) (int64, error) {
	return RecordUsageKind(db, userID, model, promptTokens, completionTokens, "chat")
}

// RecordUsageKind inserts a usage row with an explicit kind (chat | embedding).
// embedding 行的 0-token(上游省略 usage)是真实请求计数,不得被
// CleanupPendingUsage 当作流中断残留清除(审计2026-M16)。
// cost 在记录时按模型定价折算并落库(0022):后续改价/删模型不重写历史,
// 金额配额与统计均读 SUM(cost),口径一致。
func RecordUsageKind(db *sql.DB, userID int64, model string, promptTokens, completionTokens int64, kind string) (int64, error) {
	in, out := ModelPrices(db, model)
	cost := costOf(promptTokens, completionTokens, in, out)
	res, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost) VALUES (?, ?, ?, ?, ?, ?)`,
		userID, model, promptTokens, completionTokens, kind, cost)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateUsageTokens backfills token counts on an existing usage row (pending
// row) and recomputes cost from the row's model pricing (0022).
func UpdateUsageTokens(db *sql.DB, id, promptTokens, completionTokens int64) error {
	var model string
	if err := db.QueryRow("SELECT model FROM usage WHERE id = ?", id).Scan(&model); err != nil {
		return err
	}
	in, out := ModelPrices(db, model)
	cost := costOf(promptTokens, completionTokens, in, out)
	_, err := db.Exec("UPDATE usage SET prompt_tokens = ?, completion_tokens = ?, cost = ? WHERE id = ?",
		promptTokens, completionTokens, cost, id)
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

// UserMonthlyCost returns the user's total cost (yuan) in the current
// calendar month (SUM of denormalized usage.cost, 0022).
func UserMonthlyCost(db *sql.DB, userID int64) (float64, error) {
	var total float64
	err := db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage WHERE user_id = ? AND created_at >= ?`,
		userID, monthStart(time.Now()).Format(sqliteTimeFmt)).Scan(&total)
	return total, err
}

// UserMonthlyCostBatch returns a map of user_id → cost (yuan) this calendar
// month for a bounded set of users (one query, no N+1).
func UserMonthlyCostBatch(db *sql.DB, userIDs []int64) (map[int64]float64, error) {
	out := map[int64]float64{}
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
	rows, err := db.Query(`SELECT user_id, COALESCE(SUM(cost),0) AS c
		FROM usage WHERE created_at >= ? AND user_id IN (`+placeholders+`) GROUP BY user_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid int64
		var c float64
		if err := rows.Scan(&uid, &c); err != nil {
			return nil, err
		}
		out[uid] = c
	}
	return out, rows.Err()
}

// EffectiveMoneyQuota returns a user's monthly traffic quota in yuan: a
// per-user override wins, otherwise the global default (settings
// usage.monthly_quota_money). 0 = unlimited. Admins are always unlimited.
func EffectiveMoneyQuota(db *sql.DB, user *User) (float64, error) {
	if user.IsAdmin {
		return 0, nil
	}
	if user.QuotaMoney != nil {
		return *user.QuotaMoney, nil
	}
	v, ok, err := GetSetting(db, MonthlyMoneyQuotaSetting)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, nil
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || n < 0 {
		return 0, nil
	}
	return n, nil
}

// UsageAggregateRow is one aggregated usage row.
type UsageAggregateRow struct {
	Label            string `json:"label"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	Requests         int64  `json:"requests"`
	// kind 拆分(审计2026-E2):embedding 行 prompt_tokens>0 且 completion_tokens=0,
	// 单独统计便于前端区分 chat/embedding 用量;chat = Requests - EmbedRequests。
	EmbedRequests int64 `json:"embed_requests"`
	EmbedTokens   int64 `json:"embed_tokens"`
	// Cost 该桶费用合计(元,0022):SUM(usage.cost),未定价模型贡献 0。
	Cost float64 `json:"cost"`
}

// UsageAggregateOption 为 UsageAggregate 的可选过滤条件。
type UsageAggregateOption func(*UsageAggregateQuery)

// UsageAggregateQuery 收集聚合过滤条件。
type UsageAggregateQuery struct {
	Username string // 仅统计该用户名(用于用户钻取)
}

// WithUsername 只聚合指定用户名(JOIN users),用于用户详情钻取。
func WithUsername(username string) UsageAggregateOption {
	return func(q *UsageAggregateQuery) { q.Username = username }
}

// zeroFiller 生成完整的时间桶序列(缺桶填 0),避免折线跨缺日直连。
type zeroFiller func(from, to time.Time) []string

func dayFill(from, to time.Time) []string {
	out := []string{}
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

func weekFill(from, to time.Time) []string {
	out := []string{}
	for d := from; !d.After(to); d = d.AddDate(0, 0, 7) {
		out = append(out, weekMonday(d))
	}
	return out
}

// weekMonday 返回该日期所在周的周一日期(YYYY-MM-DD)。SQL 侧用
// date(created_at,'weekday 0','-6 days') 得到同一周一,两者严格对齐,
// 免疫 ISO/%W 的跨年边界差异(审计2026-E2)。
func weekMonday(d time.Time) string {
	wd := int(d.Weekday()) // 0=Sunday..6=Saturday
	// 周一前推 wd-1 天;Sunday(wd=0)前推 6 天
	back := (wd + 6) % 7
	return d.AddDate(0, 0, -back).Format("2006-01-02")
}

func monthFill(from, to time.Time) []string {
	out := []string{}
	// 先归一到月初再 +1 月:避免 from=9/30 时 AddDate(0,1,0)→10/30 越过
	// to=10/15 导致 10 月桶被跳过(审计2026-E3 P1-2)
	cur := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, from.Location())
	end := time.Date(to.Year(), to.Month(), 1, 0, 0, 0, 0, to.Location())
	for cur.Before(end) || cur.Equal(end) {
		out = append(out, cur.Format("2006-01"))
		cur = cur.AddDate(0, 1, 0)
	}
	return out
}

// UsageAggregate aggregates usage by day | week | month | model | user | kind
// between from/to (zero time means unbounded).时间分组在给定 from/to 时按日/
// 周/月补零(缺桶填 0);按 user 分组时标签用用户名(JOIN users),查无行时
// 回退用户 ID。kind 为拆分字段而非分组维度,见 UsageAggregateRow 注释。
func UsageAggregate(db *sql.DB, from, to time.Time, group string, opts ...UsageAggregateOption) ([]UsageAggregateRow, error) {
	var q UsageAggregateQuery
	for _, o := range opts {
		o(&q)
	}
	var selectExpr, groupExpr string
	join := ""
	fill := zeroFiller(nil)
	// username 过滤用相关子查询:避免与 group=user 的 LEFT JOIN users 双 JOIN
	// 同别名冲突(审计2026-E3 P1-1)
	var usernameFilter string
	if q.Username != "" {
		usernameFilter = " AND usage.user_id = (SELECT id FROM users WHERE username = ?)"
	}
	switch group {
	case "day":
		selectExpr, groupExpr = "date(usage.created_at)", "date(usage.created_at)"
		fill = dayFill
	case "week":
		// 按周一日期分桶:date(created_at,'weekday 0','-6 days') 与
		// weekMonday 严格对齐,免疫 ISO/%W 跨年差异(审计2026-E2)
		selectExpr, groupExpr = "date(usage.created_at, 'weekday 0', '-6 days')", "date(usage.created_at, 'weekday 0', '-6 days')"
		fill = weekFill
	case "month":
		selectExpr, groupExpr = "strftime('%Y-%m', usage.created_at)", "strftime('%Y-%m', usage.created_at)"
		fill = monthFill
	case "model":
		selectExpr, groupExpr = "usage.model", "usage.model"
	default:
		join = " LEFT JOIN users u ON u.id = usage.user_id"
		selectExpr, groupExpr = "COALESCE(u.username, CAST(usage.user_id AS TEXT))", "u.username, usage.user_id"
	}
	qstr := `SELECT ` + selectExpr + ` AS label,
		SUM(usage.prompt_tokens) AS pt, SUM(usage.completion_tokens) AS ct, COUNT(*) AS req,
		SUM(CASE WHEN usage.kind = 'embedding' THEN 1 ELSE 0 END) AS ereq,
		SUM(CASE WHEN usage.kind = 'embedding' THEN usage.prompt_tokens ELSE 0 END) AS etok,
		SUM(usage.cost) AS cost
		FROM usage` + join + ` WHERE 1=1`
	var args []any
	if !from.IsZero() {
		qstr += " AND usage.created_at >= ?"
		args = append(args, from.Format("2006-01-02"))
	}
	if !to.IsZero() {
		// AddDate(0,0,1) 日历下一天,避免 Add(24h) 在 DST 切换日跳到后天
		// (审计2026-E3 P1-3)
		qstr += " AND usage.created_at < ?"
		args = append(args, to.AddDate(0, 0, 1).Format("2006-01-02"))
	}
	if q.Username != "" {
		qstr += usernameFilter
		args = append(args, q.Username)
	}
	qstr += " GROUP BY " + groupExpr + " ORDER BY label"
	rows, err := db.Query(qstr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageAggregateRow{}
	for rows.Next() {
		var r UsageAggregateRow
		if err := rows.Scan(&r.Label, &r.PromptTokens, &r.CompletionTokens, &r.Requests, &r.EmbedRequests, &r.EmbedTokens, &r.Cost); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 时间分组补零:缺失桶填 0(修复 D1:折线不跨缺日直连)
	if fill != nil && !from.IsZero() && !to.IsZero() {
		byLabel := map[string]UsageAggregateRow{}
		for _, r := range out {
			byLabel[r.Label] = r
		}
		filled := []UsageAggregateRow{}
		for _, bucket := range fill(from, to) {
			if r, ok := byLabel[bucket]; ok {
				filled = append(filled, r)
			} else {
				filled = append(filled, UsageAggregateRow{Label: bucket})
			}
		}
		out = filled
	}
	return out, nil
}
