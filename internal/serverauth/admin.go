package serverauth

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

const sessionCookieName = "picoaide_session"

// secureCookiesEnabled reads server.secure_cookies(反代部署手动开启 Secure 标记)
func secureCookiesEnabled(db *sql.DB) bool {
	v, ok, err := serverstore.GetSetting(db, "server.secure_cookies")
	return err == nil && ok && strings.TrimSpace(v) == "1"
}

// minPasswordLength is the minimum password length for admin-created users.
// Password expiry is deliberately out of scope for now.
const minPasswordLength = 10

// adminLoginLimiter bounds admin login attempts (ip+username) so the
// password is not brute-forceable without rate limiting.
// 延迟到首次登录调用时创建(惰性单例):newLoginLimiter 在包 init 时读
// PICOAI_LOGIN_MAX_ATTEMPTS,若包级立即初始化,测试 t.Setenv 来不及生效,
// 多用例登录同一用户会互相限流(审计2026-M10 后新增用例触发)。
var adminLoginLimiterOnce sync.Once
var adminLoginLimiterVal *loginLimiter

func adminLoginLimiter() *loginLimiter {
	adminLoginLimiterOnce.Do(func() {
		adminLoginLimiterVal = newLoginLimiter()
	})
	return adminLoginLimiterVal
}

// AdminAPI holds the admin web handlers.
type AdminAPI struct {
	DB *sql.DB
}

// RegisterAdminRoutes mounts /api/admin/* with session+CSRF protection.
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB) {
	a := &AdminAPI{DB: db}
	g := r.Group("/api/admin")
	g.POST("/login", a.handleLogin)
	g.GET("/me", AdminAuth(db), a.handleMe)
	g.POST("/logout", AdminAuth(db), a.handleLogout)
	g.GET("/users", AdminAuth(db), a.listUsers)
	g.POST("/users", AdminAuth(db), a.createUser)
	g.PUT("/users/:id", AdminAuth(db), a.updateUser)
	g.DELETE("/users/:id", AdminAuth(db), a.deleteUser)
	g.GET("/users/:id/groups", AdminAuth(db), a.getUserGroups)
	// 单部门归属:多部门 set 端点已移除(与金字塔单部门模型冲突,审计2026-C6)
	g.PUT("/users/:id/department", AdminAuth(db), a.setUserDepartment)
	// 部门管理(金字塔组织架构)
	g.GET("/departments", AdminAuth(db), a.listDepartments)
	g.POST("/departments", AdminAuth(db), a.createDepartment)
	g.PUT("/departments/:id", AdminAuth(db), a.updateDepartment)
	g.DELETE("/departments/:id", AdminAuth(db), a.deleteDepartment)
	g.GET("/users/:id/tokens", AdminAuth(db), a.listUserTokens)
	g.POST("/tokens/:id/revoke", AdminAuth(db), a.revokeToken)
	g.GET("/usage", AdminAuth(db), a.usage)
}

// AdminAuth validates the admin session cookie and (for non-GET) CSRF token.
// Export the current admin user via serverauth.AdminUser(c).
func AdminAuth(db *sql.DB) gin.HandlerFunc {
	a := &AdminAPI{DB: db}
	return a.adminAuth()
}

// AdminUser returns the admin user from the AdminAuth context.
func AdminUser(c *gin.Context) *serverstore.User { return currentAdmin(c) }

// adminAuth validates session cookie and CSRF token for state-changing methods.
func (a *AdminAPI) adminAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		cookie, err := c.Cookie(sessionCookieName)
		if err != nil || cookie == "" {
			writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
			return
		}
		u, err := ValidateAdminSession(a.DB, cookie)
		if err != nil {
			writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "会话无效或已过期")
			return
		}
		c.Set("admin_user", u)
		c.Set("admin_session", cookie)
		if c.Request.Method != "GET" && c.Request.Method != "HEAD" {
			sess, err := GetAdminSession(a.DB, cookie)
			if err != nil || !VerifyCSRF(sess.CSRFKey, c.GetHeader("X-CSRF-Token"), time.Now()) {
				writeError(c, http.StatusForbidden, "FORBIDDEN", "CSRF 校验失败")
				return
			}
		}
		c.Next()
	}
}

// AuthenticateConfiguredAdmin authenticates an admin login through the same
// provider registry as the client login (ConfigureProviders):在 auth.mode=ldap
// 模式下,过期本地管理员无法绕开配置直接登录管理页。返回用户行(须已存在或
// 可 provision),调用方仍需校验 IsAdmin。
func AuthenticateConfiguredAdmin(db *sql.DB, username, password string) (*serverstore.User, error) {
	pwds, _ := ConfigureProviders(db)
	order := []string{"ldap", "local"}
	var lastErr error
	for _, name := range order {
		var p PasswordProvider
		for _, cand := range pwds {
			if cand.Name() == name {
				p = cand
				break
			}
		}
		if p == nil {
			continue
		}
		ui, err := p.Authenticate(username, password)
		if err != nil {
			lastErr = err
			continue
		}
		u, err := provisionUser(db, ui)
		if err != nil {
			return nil, err
		}
		return u, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no password provider configured")
	}
	return nil, lastErr
}

func (a *AdminAPI) handleLogin(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Username == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	if !adminLoginLimiter().allow(loginKey(c, req.Username)) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过于频繁,请稍后再试")
		return
	}
	u, err := AuthenticateConfiguredAdmin(a.DB, req.Username, req.Password)
	if err != nil || !u.IsAdmin {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "用户名或密码错误或非管理员")
		return
	}
	sess, csrf, err := CreateAdminSession(a.DB, u.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "会话创建失败")
		return
	}
	// Secure cookie:直接 TLS 或 server.secure_cookies=1(反代后置)时开启,
	// 避免会话 cookie 在明文跳段裸奔(审计2026-M6)
	secure := c.Request.TLS != nil || secureCookiesEnabled(a.DB)
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sess.ID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		MaxAge:   int(AdminSessionTTL.Seconds()),
	})
	c.JSON(http.StatusOK, gin.H{"csrf_token": csrf, "user": userJSON(u)})
}

func (a *AdminAPI) handleMe(c *gin.Context) {
	u := currentAdmin(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
		return
	}
	// 返回当前会话的 CSRF token:管理页刷新后(内存 token 丢失)可直接续用,无需重新登录
	sid, _ := c.Get("admin_session")
	csrf := ""
	if s, ok := sid.(string); ok {
		if sess, err := GetAdminSession(a.DB, s); err == nil {
			csrf = IssueCSRF(sess.CSRFKey, time.Now())
		}
	}
	c.JSON(http.StatusOK, gin.H{"user": userJSON(u), "csrf_token": csrf})
}

func (a *AdminAPI) handleLogout(c *gin.Context) {
	if sid, ok := c.Get("admin_session"); ok {
		if s, ok := sid.(string); ok {
			_ = DeleteAdminSession(a.DB, s)
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *AdminAPI) listUsers(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	// 页数上限:超大 page 的 (page-1)*size 会 int 溢出/负偏移(审计2026-L9)
	if page > 100000 {
		page = 100000
	}
	if size < 1 || size > 200 {
		size = 20
	}
	users, total, err := serverstore.ListUsers(a.DB, (page-1)*size, size, c.Query("q"))
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	// 批量附组(部门归属):单条 SQL 避免 N+1
	groupsByUser, err := serverstore.UserGroupsBatch(a.DB, users)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	// 批量附本月流量用量(配额对照):单条 SQL 避免 N+1
	ids := make([]int64, 0, len(users))
	for i := range users {
		ids = append(ids, users[i].ID)
	}
	usageByUser, err := serverstore.UserMonthlyUsageBatch(a.DB, ids)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	costByUser, err := serverstore.UserMonthlyCostBatch(a.DB, ids)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(users))
	for _, u := range users {
		uj := userJSON(&u)
		uj["groups"] = groupsByUser[u.ID]
		if uj["groups"] == nil {
			uj["groups"] = []string{}
		}
		uj["monthly_usage"] = usageByUser[u.ID] // tokens used this calendar month (0 when none)
		uj["monthly_cost"] = costByUser[u.ID]   // yuan spent this calendar month (0 when none)
		out = append(out, uj)
	}
	c.JSON(http.StatusOK, gin.H{"users": out, "total": total, "page": page, "size": size})
}

// getUserGroups returns the group names a user belongs to.
func (a *AdminAPI) getUserGroups(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	if _, err := serverstore.GetUserByID(a.DB, id); errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	groups, err := serverstore.UserGroups(a.DB, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if groups == nil {
		groups = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"groups": groups})
}

// setUserGroups 已随多部门端点移除(审计2026-C6):员工单部门归属一律走
// PUT /users/:id/department;此处保留仅为类型说明,实际不注册路由。
// nolint:unused // 保留防误注册的语义说明
func (a *AdminAPI) setUserGroups(c *gin.Context) {
	writeError(c, http.StatusNotFound, "NOT_FOUND", "该端点已移除,请使用 PUT /users/:id/department")
}

func (a *AdminAPI) createUser(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		IsAdmin  bool   `json:"is_admin"`
		Status   int    `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Username == "" || req.Password == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "用户名和密码必填")
		return
	}
	if utf8.RuneCountInString(req.Password) < minPasswordLength {
		writeError(c, http.StatusBadRequest, "VALIDATION", "密码至少 10 位")
		return
	}
	status := req.Status
	if status == 0 {
		status = 1
	}
	// status 只允许 0/1(审计2026-L6)
	if status != 0 && status != 1 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "status 只能是 0 或 1")
		return
	}
	id, err := serverstore.CreateUserWithPassword(a.DB, req.Username, req.Password)
	if errors.Is(err, serverstore.ErrDuplicate) {
		writeError(c, http.StatusBadRequest, "VALIDATION", "用户名已存在")
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	if req.IsAdmin || status != 1 {
		u.IsAdmin = req.IsAdmin
		u.Status = status
		if err := serverstore.UpdateUser(a.DB, u); err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
			return
		}
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_create", u.Username)
	c.JSON(http.StatusOK, gin.H{"user": userJSON(u)})
}

func (a *AdminAPI) updateUser(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req struct {
		DisplayName     *string  `json:"display_name"`
		Email           *string  `json:"email"`
		Password        *string  `json:"password"`
		IsAdmin         *bool    `json:"is_admin"`
		Status          *int     `json:"status"`
		QuotaTokens     *int64   `json:"quota_tokens"`
		QuotaClear      bool     `json:"quota_clear"` // reset quota_tokens to NULL (follow global default)
		QuotaMoney      *float64 `json:"quota_money"`
		QuotaMoneyClear bool     `json:"quota_money_clear"` // reset quota_money to NULL (follow global default)
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	me := currentAdmin(c)
	wasAdmin := u.IsAdmin
	wasStatus := u.Status
	// guard: cannot disable/remove admin rights of yourself or the last admin
	if req.IsAdmin != nil && !*req.IsAdmin && u.IsAdmin && me != nil && me.ID == u.ID {
		writeError(c, http.StatusBadRequest, "VALIDATION", "不能取消自己的管理员权限")
		return
	}
	if req.Status != nil && *req.Status != 1 && u.IsAdmin && me != nil && me.ID == u.ID {
		writeError(c, http.StatusBadRequest, "VALIDATION", "不能禁用自己")
		return
	}
	if req.DisplayName != nil {
		u.DisplayName = *req.DisplayName
	}
	if req.Email != nil {
		u.Email = *req.Email
	}
	if req.Password != nil && *req.Password != "" {
		// 外部(LDAP/OIDC)用户的密码由 IdP 管理:改写本地密码并置 Source=local 会
		// 让该用户被永久踢出 IdP(provision 防接管守卫拒绝其再次登录)——直接拒绝
		if u.Source == "external" {
			writeError(c, http.StatusBadRequest, "VALIDATION", "外部认证用户的密码由企业 IdP 管理,不能在此修改")
			return
		}
		if utf8.RuneCountInString(*req.Password) < minPasswordLength {
			writeError(c, http.StatusBadRequest, "VALIDATION", "密码至少 10 位")
			return
		}
		hash, err := util.HashPassword(*req.Password)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "密码处理失败")
			return
		}
		u.PasswordHash = hash
	}
	if req.IsAdmin != nil {
		u.IsAdmin = *req.IsAdmin
	}
	if req.Status != nil {
		u.Status = *req.Status
	}
	if req.QuotaClear {
		u.QuotaTokens = nil
	} else if req.QuotaTokens != nil {
		if *req.QuotaTokens < 0 {
			writeError(c, http.StatusBadRequest, "VALIDATION", "quota_tokens 不能为负数")
			return
		}
		q := *req.QuotaTokens
		u.QuotaTokens = &q
	}
	if req.QuotaMoneyClear {
		u.QuotaMoney = nil
	} else if req.QuotaMoney != nil {
		if *req.QuotaMoney < 0 {
			writeError(c, http.StatusBadRequest, "VALIDATION", "quota_money 不能为负数")
			return
		}
		q := *req.QuotaMoney
		u.QuotaMoney = &q
	}
	// 权限敏感变更:改密 / 取消管理员 / 禁用 → 吊销全部 API token,
	// 旧凭证立即失效(防已登录客户端继续以旧权限访问)。
	// 与用户更新同事务(审计2026-L16):更新成功但吊销失败不再留下旧凭证
	demote := (req.Password != nil && *req.Password != "") || (req.IsAdmin != nil && !*req.IsAdmin && wasAdmin) ||
		(req.Status != nil && *req.Status != 1 && wasStatus == 1)
	if demote {
		if err := serverstore.UpdateUserRevokingTokens(a.DB, u); err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_tokens_revoked", u.Username)
	} else if err := serverstore.UpdateUser(a.DB, u); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_update", u.Username)
	c.JSON(http.StatusOK, gin.H{"user": userJSON(u)})
}

func (a *AdminAPI) deleteUser(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	me := currentAdmin(c)
	if me != nil && me.ID == u.ID {
		writeError(c, http.StatusBadRequest, "VALIDATION", "不能删除自己")
		return
	}
	// C-17: the last-admin guard runs inside the DeleteUser transaction;
	// the pre-check was removed to close the count-then-delete TOCTOU.
	if err := serverstore.DeleteUser(a.DB, id); err != nil {
		if errors.Is(err, serverstore.ErrLastAdmin) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "不能删除最后一个管理员")
			return
		}
		writeError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_delete", u.Username)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// tokenJSON is the non-sensitive admin view of an API token.
type tokenJSON struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	CreatedAt  string `json:"created_at"`
	ExpiresAt  string `json:"expires_at"`
	LastUsedAt string `json:"last_used_at"`
	Revoked    int    `json:"revoked"`
}

func (a *AdminAPI) listUserTokens(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	if _, err := serverstore.GetUserByID(a.DB, id); errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	tokens, err := serverstore.ListTokensByUser(a.DB, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]tokenJSON, 0, len(tokens))
	for _, tk := range tokens {
		lastUsed := ""
		if !tk.LastUsedAt.IsZero() {
			lastUsed = tk.LastUsedAt.Format(time.RFC3339)
		}
		out = append(out, tokenJSON{
			ID: tk.ID, Name: tk.Name, CreatedAt: tk.CreatedAt,
			ExpiresAt: tk.ExpiresAt.Format(time.RFC3339), LastUsedAt: lastUsed, Revoked: tk.Revoked,
		})
	}
	c.JSON(http.StatusOK, gin.H{"tokens": out})
}

func (a *AdminAPI) revokeToken(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法令牌 ID")
		return
	}
	if err := serverstore.RevokeTokenByID(a.DB, id); errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "令牌不存在")
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "撤销失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *AdminAPI) usage(c *gin.Context) {
	// 日期解析失败 → 400,而不是静默无界范围(审计2026-L7)
	fromRaw := c.DefaultQuery("from", "")
	toRaw := c.DefaultQuery("to", "")
	var from, to time.Time
	var err error
	if fromRaw != "" {
		if from, err = time.Parse("2006-01-02", fromRaw); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "from 日期格式错误(YYYY-MM-DD)")
			return
		}
	}
	if toRaw != "" {
		if to, err = time.Parse("2006-01-02", toRaw); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "to 日期格式错误(YYYY-MM-DD)")
			return
		}
	}
	group := c.DefaultQuery("group", "day")
	if group != "day" && group != "week" && group != "month" && group != "model" && group != "user" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "group 必须是 day|week|month|model|user")
		return
	}
	var opts []serverstore.UsageAggregateOption
	if username := c.Query("username"); username != "" {
		opts = append(opts, serverstore.WithUsername(username))
	}
	rows, err := serverstore.UsageAggregate(a.DB, from, to, group, opts...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"rows": rows, "group": group})
}

func currentAdmin(c *gin.Context) *serverstore.User {
	v, _ := c.Get("admin_user")
	u, _ := v.(*serverstore.User)
	return u
}

func currentAdminUsername(c *gin.Context) string {
	if u := currentAdmin(c); u != nil {
		return u.Username
	}
	return "admin"
}

// ---- 部门管理(金字塔组织架构) ----

type deptReq struct {
	Name        string `json:"name"`
	ParentID    int64  `json:"parent_id"`
	LeaderID    int64  `json:"leader_id"`
	Description string `json:"description"`
	// BudgetMoney 部门月度金额预算(元,0024):nil = 不变,0 = 清除(不限),>0 = 预算。
	BudgetMoney *float64 `json:"budget_money"`
}

// listDepartments 返回部门树平铺(含主管/成员数/子部门数/授权引用数)。
func (a *AdminAPI) listDepartments(c *gin.Context) {
	list, err := serverstore.ListDepartments(a.DB)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if list == nil {
		list = []serverstore.DepartmentInfo{}
	}
	c.JSON(http.StatusOK, gin.H{"departments": list})
}

func (a *AdminAPI) createDepartment(c *gin.Context) {
	var req deptReq
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "部门名称必填")
		return
	}
	id, err := serverstore.CreateDepartment(a.DB, strings.TrimSpace(req.Name), req.ParentID, req.LeaderID, req.Description)
	if err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门名称已存在")
			return
		}
		if errors.Is(err, serverstore.ErrNotFound) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "上级部门或主管不存在")
			return
		}
		writeError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "dept_create", req.Name)
	c.JSON(http.StatusOK, gin.H{"department": gin.H{"id": id, "name": req.Name}})
}

func (a *AdminAPI) updateDepartment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法部门 ID")
		return
	}
	var req deptReq
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "部门名称必填")
		return
	}
	before, err := serverstore.GroupByID(a.DB, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "部门不存在")
		return
	}
	if req.BudgetMoney != nil && *req.BudgetMoney < 0 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "budget_money 不能为负数")
		return
	}
	if err := serverstore.UpdateDepartment(a.DB, id, strings.TrimSpace(req.Name), req.ParentID, req.LeaderID, req.Description); err != nil {
		if errors.Is(err, serverstore.ErrValidation) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "上级部门不能是自身或子部门")
			return
		}
		if errors.Is(err, serverstore.ErrDuplicate) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门名称已存在")
			return
		}
		if errors.Is(err, serverstore.ErrNotFound) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "上级部门或主管不存在")
			return
		}
		writeError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	// 部门预算(0024):与部门更新同事务语义 —— 更新后再设预算,失败不落脏
	if req.BudgetMoney != nil {
		if err := serverstore.SetDeptBudget(a.DB, id, *req.BudgetMoney); err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "保存预算失败")
			return
		}
	}
	detail := fmt.Sprintf("%s→%s parent:%d→%d leader:%d→%d",
		before.Name, req.Name, before.ParentID, req.ParentID, before.LeaderID, req.LeaderID)
	if req.BudgetMoney != nil {
		detail += fmt.Sprintf(" budget:%.2f", *req.BudgetMoney)
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "dept_update", detail)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *AdminAPI) deleteDepartment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法部门 ID")
		return
	}
	before, err := serverstore.GroupByID(a.DB, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "部门不存在")
		return
	}
	if err := serverstore.DeleteDepartment(a.DB, id); err != nil {
		if errors.Is(err, serverstore.ErrDepartmentInUse) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门仍有关联(成员/子部门/授权),请先转移或清理")
			return
		}
		writeError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "dept_delete", before.Name)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// setUserDepartment 单部门归属(员工金字塔单选):替换用户全部组为指定部门。
func (a *AdminAPI) setUserDepartment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	}
	var req struct {
		GroupID int64 `json:"group_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	var names []string
	if req.GroupID > 0 {
		g, err := serverstore.GroupByID(a.DB, req.GroupID)
		if err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门不存在")
			return
		}
		names = []string{g.Name}
	}
	if err := serverstore.SyncUserGroups(a.DB, id, names); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_dept", u.Username+" → "+strings.Join(names, ","))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
