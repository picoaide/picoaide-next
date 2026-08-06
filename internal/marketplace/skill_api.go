package marketplace

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// API holds the marketplace handlers' dependencies.
type API struct {
	DB       *sql.DB
	CacheDir string

	// configRateLimit/rateWindow bound credential fetches per user
	// (defaults: 30/hour, see NewAPI).
	configRateLimit int
	rateWindow      time.Duration
	mu              sync.Mutex
	configHits      map[int64]*rateCounter
}

type rateCounter struct {
	windowStart time.Time
	count       int
}

// NewAPI creates the marketplace API with a 30/hour per-user config limit.
func NewAPI(db *sql.DB, cacheDir string) *API {
	return &API{
		DB:              db,
		CacheDir:        cacheDir,
		configRateLimit: 30,
		rateWindow:      time.Hour,
		configHits:      map[int64]*rateCounter{},
	}
}

// RegisterRoutes mounts the /api/marketplace endpoints. All require login.
func (a *API) RegisterRoutes(r *gin.Engine) {
	g := r.Group("/api/marketplace", serverauth.BearerAuth(a.DB))
	g.GET("/skills", a.listSkills)
	g.GET("/skills/:name", a.getSkill)
	g.GET("/skills/:name/archive", a.downloadArchive)
	g.GET("/mcp", a.listMCP)
	g.GET("/mcp/:id/config", a.getMCPConfig)
}

func (a *API) listSkills(c *gin.Context) {
	list, err := serverstore.ListSkills(a.DB, true)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能列表读取失败")
		return
	}
	skills := make([]gin.H, 0, len(list))
	for _, s := range list {
		skills = append(skills, skillJSON(s))
	}
	c.JSON(http.StatusOK, gin.H{"skills": skills})
}

func (a *API) getSkill(c *gin.Context) {
	s, err := serverstore.GetSkill(a.DB, c.Param("name"))
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能读取失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"skill": skillJSON(*s)})
}

func (a *API) downloadArchive(c *gin.Context) {
	s, err := serverstore.GetSkill(a.DB, c.Param("name"))
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能读取失败")
		return
	}
	if s.Enabled != 1 {
		// C-10: 下架即不可下载,与不存在同响应(与 MCP 插件一致)
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能已下架")
		return
	}
	if !util.SafePathSegment(s.Name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	if err := os.MkdirAll(a.CacheDir, 0700); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "缓存目录创建失败")
		return
	}
	repoDir := filepath.Join(a.CacheDir, s.Name)
	if _, err := os.Stat(repoDir); os.IsNotExist(err) {
		if err := CloneRepo(s.GitURL, s.GitRef, repoDir); err != nil {
			serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "技能源克隆失败")
			return
		}
	}
	pkg, err := BuildPackage(repoDir, s.Name, s.Version)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "技能打包失败")
		return
	}
	// SHA-256 of the built archive: persisted once into the skills row and
	// served to clients so they can reject tampered/corrupt downloads.
	sum, err := fileSHA256(pkg)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能校验失败")
		return
	}
	if s.Checksum != sum {
		s.Checksum = sum
		// best effort: the header is authoritative for the bytes served;
		// the row is re-synced on the next download if this write fails.
		_ = serverstore.UpdateSkill(a.DB, s)
	}
	c.Header("Content-Type", "application/gzip")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", s.Name+"-"+s.Version+".tar.gz"))
	c.Header("X-Skill-Version", s.Version)
	c.Header("X-Skill-Checksum", sum)
	c.File(pkg)
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func skillJSON(s serverstore.Skill) gin.H {
	return gin.H{
		"id":          s.ID,
		"name":        s.Name,
		"version":     s.Version,
		"description": s.Description,
		"author":      s.Author,
		"git_url":     s.GitURL,
		"git_ref":     s.GitRef,
		"checksum":    s.Checksum,
		"enabled":     s.Enabled == 1,
		"created_at":  s.CreatedAt,
		"updated_at":  s.UpdatedAt,
	}
}

func (a *API) listMCP(c *gin.Context) {
	list, err := serverstore.ListMCPServers(a.DB, true)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "插件列表读取失败")
		return
	}
	out := make([]gin.H, 0, len(list))
	for _, m := range list {
		out = append(out, mcpJSON(m, maskValues(m.Env), maskValues(m.Headers)))
	}
	c.JSON(http.StatusOK, gin.H{"mcp": out})
}

func (a *API) getMCPConfig(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效的插件 ID")
		return
	}
	u := serverauth.CurrentUser(c)
	if u == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	m, err := serverstore.GetMCPServer(a.DB, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "插件读取失败")
		return
	}
	if m.Enabled != 1 {
		// 建议安装制:下架即不可拉取,与不存在同响应
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件已下架")
		return
	}
	if !a.configTake(u.ID) {
		serverauth.WriteError(c, http.StatusTooManyRequests, "RATE_LIMITED", "拉取过于频繁,请稍后再试")
		return
	}
	key, err := util.GetMasterKey()
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "主密钥未初始化")
		return
	}
	env, err := DecryptEnv(key, m.Env)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "凭证解密失败")
		return
	}
	headers, err := DecryptEnv(key, m.Headers)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "凭证解密失败")
		return
	}
	if err := serverstore.RecordDownload(a.DB, u.ID, m.ID); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "审计记录失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"config": mcpJSON(*m, env, headers)})
}

// configTake checks the per-user budget and records the take in one critical
// section (C-11: a split check-then-act would let concurrent requests blow
// past the limit). Stale windows are pruned on every take.
func (a *API) configTake(userID int64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	// ponytail: map is bounded by the user count (small in practice), so
	// pruning on every take is fine; switch to a size threshold if it grows
	for id, rc := range a.configHits {
		if time.Since(rc.windowStart) > 2*a.rateWindow {
			delete(a.configHits, id)
		}
	}
	rc := a.configHits[userID]
	if rc != nil && time.Since(rc.windowStart) <= a.rateWindow && rc.count >= a.configRateLimit {
		return false
	}
	if rc == nil || time.Since(rc.windowStart) > a.rateWindow {
		rc = &rateCounter{windowStart: time.Now()}
		a.configHits[userID] = rc
	}
	rc.count++
	return true
}

func mcpJSON(m serverstore.MCPServer, env, headers map[string]string) gin.H {
	return gin.H{
		"id":          m.ID,
		"name":        m.Name,
		"description": m.Description,
		"transport":   m.Transport,
		"command":     m.Command,
		"args":        m.Args,
		"url":         m.URL,
		"env":         env,
		"headers":     headers,
	}
}

func maskValues(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k := range m {
		out[k] = "***"
	}
	return out
}
