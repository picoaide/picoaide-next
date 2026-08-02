package llmgateway

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

func adminTestSetup(t *testing.T) (http.Handler, *sql.DB, map[string]string) {
	t.Helper()
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/admin.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	// admin user
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "boss")
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	serverauth.RegisterAdminRoutes(r, db)
	RegisterAdminRoutes(r, db)

	// login
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	return r, db, hdr
}

func adminReq(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestAdminProviders(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// create provider with key
	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"sk-secret-xyz","models":["deepseek-chat"]}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create provider: %d %s", w.Code, w.Body.String())
	}
	// key must be encrypted at rest, masked in response
	p := out["provider"].(map[string]any)
	if p["api_key"] != "***" {
		t.Fatalf("api_key not masked: %v", p["api_key"])
	}
	providers, _ := serverstore.ListGatewayProviders(db)
	if len(providers) != 1 || providers[0].APIKeyEnc == "sk-secret-xyz" {
		t.Fatalf("key not encrypted at rest: %+v", providers)
	}
	if !strings.HasPrefix(providers[0].APIKeyEnc, "enc:v1:") {
		t.Fatalf("key lacks enc prefix: %q", providers[0].APIKeyEnc)
	}
	// master key decrypt round trip
	key, _ := util.GetMasterKey()
	plain, err := util.Decrypt(key, providers[0].APIKeyEnc)
	if err != nil || plain != "sk-secret-xyz" {
		t.Fatalf("decrypt round trip: %q %v", plain, err)
	}
	// non-admin → 403
	if w, _ := adminReq(t, r, "GET", "/api/admin/providers", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("no session: %d", w.Code)
	}

	// update without key keeps old
	w, _ = adminReq(t, r, "PUT", "/api/admin/providers/1", `{"base_url":"https://new.example.com"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update provider: %d", w.Code)
	}
	providers, _ = serverstore.ListGatewayProviders(db)
	if providers[0].BaseURL != "https://new.example.com" || providers[0].APIKeyEnc == "" {
		t.Fatalf("update lost key: %+v", providers[0])
	}
}

func TestAdminModelsAndDefaultModel(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"k","models":["deepseek-chat"]}`, hdr); w.Code != http.StatusOK {
		t.Fatal("create provider failed")
	}
	w, _ := adminReq(t, r, "POST", "/api/admin/models",
		`{"name":"deepseek-chat","provider_id":1,"display_name":"DeepSeek Chat"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create model: %d %s", w.Code, w.Body.String())
	}
	// default model must be in enabled models
	w, _ = adminReq(t, r, "PUT", "/api/admin/gateway", `{"default_model":"bogus-model"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bogus default model accepted: %d", w.Code)
	}
	w, _ = adminReq(t, r, "PUT", "/api/admin/gateway", `{"default_model":"deepseek-chat","allow_private":true,"search_endpoint":"https://s/q"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set default model: %d %s", w.Code, w.Body.String())
	}
	v, ok, _ := serverstore.GetSetting(db, "gateway.default_model")
	if !ok || v != "deepseek-chat" {
		t.Fatalf("default_model = %q ok=%v", v, ok)
	}
	// read back
	w, out := adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["default_model"] != "deepseek-chat" || out["allow_private"] != true {
		t.Fatalf("gateway config: %d %v", w.Code, out)
	}
	// delete model
	if w, _ := adminReq(t, r, "DELETE", "/api/admin/models/1", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete model: %d", w.Code)
	}
}

