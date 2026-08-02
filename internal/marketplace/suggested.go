package marketplace

import (
	"database/sql"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// MCPItem is one entry of the client-visible MCP suggestion list (masked).
type MCPItem struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Recommended bool   `json:"recommended"`
}

// SuggestedMCP returns the enabled MCP servers as masked suggestions,
// reusing the marketplace list logic (no direct table reads by callers).
func SuggestedMCP(db *sql.DB) ([]MCPItem, error) {
	list, err := serverstore.ListMCPServers(db, true)
	if err != nil {
		return nil, err
	}
	out := make([]MCPItem, 0, len(list))
	for _, m := range list {
		out = append(out, MCPItem{ID: m.ID, Name: m.Name, Description: m.Description, Recommended: true})
	}
	return out, nil
}
