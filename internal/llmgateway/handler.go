package llmgateway

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// defaultRateLimit is the default per-user requests per minute.
const defaultRateLimit = 60

// API holds gateway dependencies.
type API struct {
	DB     *sql.DB
	client *http.Client // non-stream requests (bounded timeout)
	sse    *http.Client // streaming requests (lifecycle = request context)
	rl     *rateLimiter
}

// handleChatCompletions proxies /v1/chat/completions to the matching upstream.
func (a *API) handleChatCompletions(c *gin.Context) {
	user := serverauth.CurrentUser(c)
	if user == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	var req struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || req.Model == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体缺少 model 字段")
		return
	}

	if !a.rl.allow(user.ID, a.rateLimitPerMinute()) {
		serverauth.WriteError(c, http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁,请稍后再试")
		return
	}

	up, err := MatchModel(a.DB, req.Model)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "模型不存在或不可用")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "模型路由查询失败")
		return
	}

	// streaming path: insert a pending usage row first, backfilled on the
	// final SSE chunk; a client disconnect leaves it pending (no rollback).
	var usageID int64
	if req.Stream {
		usageID, err = serverstore.RecordUsage(a.DB, user.ID, req.Model, 0, 0)
		if err != nil {
			log.Printf("gateway: record pending usage: %v", err)
		}
	}

	resp, err := a.forward(c, up, raw, req.Stream)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游服务不可用:"+err.Error())
		return
	}
	if req.Stream {
		a.serveStream(c, resp, usageID)
		return
	}
	a.serveJSON(c, resp, user.ID, req.Model)
}

// forward sends the raw body to the upstream, replacing Authorization with
// the upstream key; retries once on transport error or 5xx.
func (a *API) forward(c *gin.Context, up *Upstream, raw []byte, stream bool) (*http.Response, error) {
	url := strings.TrimSuffix(up.BaseURL, "/") + "/chat/completions"
	client := a.client
	if stream {
		client = a.sse
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+up.APIKey)
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode < 500 {
			return resp, nil
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		lastErr = fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	return nil, lastErr
}

// serveJSON passes a non-stream upstream response through and records usage.
func (a *API) serveJSON(c *gin.Context, resp *http.Response, userID int64, model string) {
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "读取上游响应失败")
		return
	}
	if pt, ct, ok := parseUsageBody(body); ok {
		if _, err := serverstore.RecordUsage(a.DB, userID, model, pt, ct); err != nil {
			log.Printf("gateway: record usage: %v", err)
		}
	}
	c.Status(resp.StatusCode)
	for k, vv := range resp.Header {
		for _, v := range vv {
			c.Writer.Header().Add(k, v)
		}
	}
	c.Writer.Write(body)
}

// serveStream passes an SSE response through line by line, preserving
// "data:" lines and "[DONE]", and backfills the pending usage row from the
// final chunk's "usage" field.
func (a *API) serveStream(c *gin.Context, resp *http.Response, usageID int64) {
	defer resp.Body.Close()
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.WriteHeader(resp.StatusCode)
	fl, _ := c.Writer.(http.Flusher)
	br := bufio.NewReader(resp.Body)
	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			if s := strings.TrimSpace(line); strings.HasPrefix(s, "data:") {
				if pt, ct, ok, perr := parseUsageLine(s); perr != nil {
					log.Printf("gateway: parse usage line: %v", perr)
				} else if ok && usageID > 0 {
					if uerr := serverstore.UpdateUsageTokens(a.DB, usageID, pt, ct); uerr != nil {
						log.Printf("gateway: backfill usage: %v", uerr)
					}
				}
			}
			c.Writer.WriteString(line)
			if fl != nil {
				fl.Flush()
			}
		}
		if err != nil { // EOF or client disconnect (request ctx canceled)
			break
		}
	}
}

// parseUsageLine extracts token counts from an SSE data line containing usage.
func parseUsageLine(s string) (pt, ct int64, ok bool, err error) {
	data := strings.TrimSpace(strings.TrimPrefix(s, "data:"))
	if data == "" || data == "[DONE]" {
		return 0, 0, false, nil
	}
	var chunk struct {
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(data), &chunk); err != nil {
		return 0, 0, false, err
	}
	if chunk.Usage == nil {
		return 0, 0, false, nil
	}
	return chunk.Usage.PromptTokens, chunk.Usage.CompletionTokens, true, nil
}

// parseUsageBody extracts token counts from a non-stream response body.
func parseUsageBody(body []byte) (pt, ct int64, ok bool) {
	var resp struct {
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.Usage == nil {
		return 0, 0, false
	}
	return resp.Usage.PromptTokens, resp.Usage.CompletionTokens, true
}

// rateLimitPerMinute reads the configurable per-user limit from settings.
func (a *API) rateLimitPerMinute() int {
	v, ok, err := serverstore.GetSetting(a.DB, "gateway.rate_limit")
	if err != nil || !ok {
		return defaultRateLimit
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 {
		return defaultRateLimit
	}
	return n
}

// rateLimiter is a per-user token bucket with bounded map and lazy cleanup.
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[int64]*bucket
	max     int
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{buckets: map[int64]*bucket{}, max: 10000}
}

// allow reports whether the user may proceed; rate is tokens per minute.
func (l *rateLimiter) allow(userID int64, rate int) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) >= l.max {
		for id, b := range l.buckets {
			if now.Sub(b.last) > time.Hour {
				delete(l.buckets, id)
			}
		}
	}
	b, ok := l.buckets[userID]
	if !ok {
		if len(l.buckets) >= l.max {
			return false
		}
		b = &bucket{tokens: float64(rate), last: now}
		l.buckets[userID] = b
	}
	b.tokens = math.Min(float64(rate), b.tokens+now.Sub(b.last).Seconds()*float64(rate)/60.0)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
