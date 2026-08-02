package knowledge

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// RegisterRoutes mounts /api/mcp/knowledge/* endpoints.
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	_ = db
}
