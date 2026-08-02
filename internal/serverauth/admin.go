package serverauth

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

const sessionCookieName = "picoaide_session"

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

func (a *AdminAPI) handleLogin(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Username == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	u, err := serverstore.AuthenticateLocal(a.DB, req.Username, req.Password)
	if err != nil || !u.IsAdmin {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "用户名或密码错误或非管理员")
		return
	}
	sess, csrf, err := CreateAdminSession(a.DB, u.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "会话创建失败")
		return
	}
	secure := c.Request.TLS != nil
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sess.ID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		MaxAge:   int(AdminSessionTTL.Seconds()),
	})
	c.JSON(http.StatusOK, gin.H{"csrf_token": csrf, "user": userJSON(&u)})
}

func (a *AdminAPI) handleMe(c *gin.Context) {
	u := currentAdmin(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": userJSON(u)})
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
	if size < 1 || size > 200 {
		size = 20
	}
	users, total, err := serverstore.ListUsers(a.DB, (page-1)*size, size)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(users))
	for _, u := range users {
		out = append(out, userJSON(&u))
	}
	c.JSON(http.StatusOK, gin.H{"users": out, "total": total, "page": page, "size": size})
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
	status := req.Status
	if status == 0 {
		status = 1
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
		DisplayName *string `json:"display_name"`
		Email       *string `json:"email"`
		Password    *string `json:"password"`
		IsAdmin     *bool   `json:"is_admin"`
		Status      *int    `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	me := currentAdmin(c)
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
		hash, err := utilHash(*req.Password)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "密码处理失败")
			return
		}
		u.PasswordHash = hash
		u.Source = "local"
	}
	if req.IsAdmin != nil {
		u.IsAdmin = *req.IsAdmin
	}
	if req.Status != nil {
		u.Status = *req.Status
	}
	if err := serverstore.UpdateUser(a.DB, u); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
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
	// block deleting the last admin
	if u.IsAdmin {
		admins, _, err := serverstore.ListUsers(a.DB, 0, 100000)
		if err == nil {
			count := 0
			for _, x := range admins {
				if x.IsAdmin {
					count++
				}
			}
			if count <= 1 {
				writeError(c, http.StatusBadRequest, "VALIDATION", "不能删除最后一个管理员")
				return
			}
		}
	}
	if err := serverstore.DeleteUser(a.DB, id); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *AdminAPI) usage(c *gin.Context) {
	from, _ := time.Parse("2006-01-02", c.DefaultQuery("from", ""))
	to, _ := time.Parse("2006-01-02", c.DefaultQuery("to", ""))
	group := c.DefaultQuery("group", "day")
	if group != "day" && group != "model" && group != "user" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "group 必须是 day|model|user")
		return
	}
	rows, err := serverstore.UsageAggregate(a.DB, from, to, group)
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

// utilHash wraps util.HashPassword (kept here to avoid import churn in tests).
func utilHash(pw string) (string, error) { return util.HashPassword(pw) }
