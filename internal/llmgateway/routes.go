package llmgateway

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// RegisterRoutes mounts /v1/* and /api/config/bootstrap-related endpoints.
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	_ = db
}
