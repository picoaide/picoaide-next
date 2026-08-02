package marketplace

import (
	"database/sql"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// seedMCP adds an enabled plugin with encrypted credentials and a disabled
// one; returns their ids.
func seedMCP(t *testing.T, db *sql.DB, api *API) (int64, int64) {
	t.Helper()
	key, err := util.EnsureMasterKey(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	env := EncryptEnv(key, map[string]string{
		"API_KEY": "secret-123",
		"TIMEOUT": "30",
	})
	headers := EncryptEnv(key, map[string]string{"Authorization": "Bearer hdr-secret"})
	id, err := serverstore.AddMCPServer(db, &serverstore.MCPServer{
		Name: "files", Description: "files plugin", Transport: "stdio",
		Command: "node", Args: []string{"server.js"},
		Env: env, Headers: headers, Enabled: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	off, err := serverstore.AddMCPServer(db, &serverstore.MCPServer{
		Name: "hidden", Description: "off", Transport: "stdio", Enabled: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	return id, off
}

func TestMCPAPI(t *testing.T) {
	r, db, token, api := newTestRouter(t)
	id, offID := seedMCP(t, db, api)

	// list: enabled only, all env/headers values masked
	w := doReq(r, "GET", "/api/marketplace/mcp", token)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, body %s", w.Code, w.Body.String())
	}
	var list struct {
		MCP []map[string]any `json:"mcp"`
	}
	decodeJSON(t, w, &list)
	if len(list.MCP) != 1 {
		t.Fatalf("mcp list = %+v", list.MCP)
	}
	m := list.MCP[0]
	if m["name"] != "files" || m["command"] != "node" || m["description"] != "files plugin" {
		t.Fatalf("mcp entry = %+v", m)
	}
	env, _ := m["env"].(map[string]any)
	hdr, _ := m["headers"].(map[string]any)
	if env["API_KEY"] != "***" || env["TIMEOUT"] != "***" || hdr["Authorization"] != "***" {
		t.Fatalf("masked env/headers = %v %v", env, hdr)
	}

	// config: full decrypted env/headers with a valid token
	w = doReq(r, "GET", "/api/marketplace/mcp/"+strconv.FormatInt(id, 10)+"/config", token)
	if w.Code != http.StatusOK {
		t.Fatalf("config status = %d, body %s", w.Code, w.Body.String())
	}
	var cfg struct {
		Config struct {
			Env     map[string]string `json:"env"`
			Headers map[string]string `json:"headers"`
		} `json:"config"`
	}
	decodeJSON(t, w, &cfg)
	if cfg.Config.Env["API_KEY"] != "secret-123" || cfg.Config.Env["TIMEOUT"] != "30" {
		t.Fatalf("decrypted env = %v", cfg.Config.Env)
	}
	if cfg.Config.Headers["Authorization"] != "Bearer hdr-secret" {
		t.Fatalf("decrypted headers = %v", cfg.Config.Headers)
	}
	rows, err := serverstore.ListDownloads(db, 1, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].MCPID != id {
		t.Fatalf("downloads after config = %+v", rows)
	}

	// no token -> 401
	for _, p := range []string{"/api/marketplace/mcp", "/api/marketplace/mcp/" + strconv.FormatInt(id, 10) + "/config"} {
		if w := doReq(r, "GET", p, ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("no-token %s = %d", p, w.Code)
		}
	}

	// disabled plugin -> 404
	w = doReq(r, "GET", "/api/marketplace/mcp/"+strconv.FormatInt(offID, 10)+"/config", token)
	if w.Code != http.StatusNotFound || !hasErrCode(w, "NOT_FOUND") {
		t.Fatalf("disabled config = %d, body %s", w.Code, w.Body.String())
	}
	// unknown id -> 404
	w = doReq(r, "GET", "/api/marketplace/mcp/99999/config", token)
	if w.Code != http.StatusNotFound || !hasErrCode(w, "NOT_FOUND") {
		t.Fatalf("unknown config = %d, body %s", w.Code, w.Body.String())
	}
	// bad id -> 400
	if w := doReq(r, "GET", "/api/marketplace/mcp/abc/config", token); w.Code != http.StatusBadRequest {
		t.Fatalf("bad id = %d", w.Code)
	}

	// rate limit: only 2 fetches allowed per window
	api.configRateLimit = 2
	path := "/api/marketplace/mcp/" + strconv.FormatInt(id, 10) + "/config"
	if w := doReq(r, "GET", path, token); w.Code != http.StatusOK {
		t.Fatalf("fetch 2 = %d", w.Code)
	}
	if w := doReq(r, "GET", path, token); w.Code != http.StatusTooManyRequests || !hasErrCode(w, "RATE_LIMITED") {
		t.Fatalf("fetch 3 = %d, body %s", w.Code, w.Body.String())
	}
	rows, err = serverstore.ListDownloads(db, 1, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("downloads after rate limit = %d, want 2", len(rows))
	}
}
