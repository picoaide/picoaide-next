package llmgateway

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
)

// RegisterRoutes mounts /v1/chat/completions and /v1/models behind
// bearer-token auth.
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	a := &API{
		DB:     db,
		client: &http.Client{Timeout: 120 * time.Second},
		sse:    &http.Client{},
		rl:     newRateLimiter(),
	}
	v1 := r.Group("/v1", serverauth.BearerAuth(db))
	v1.POST("/chat/completions", a.handleChatCompletions)
	v1.GET("/models", a.handleModels)
}
