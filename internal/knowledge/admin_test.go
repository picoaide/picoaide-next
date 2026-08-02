package knowledge

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
)

func kbAdminSetup(t *testing.T) (http.Handler, *sql.DB, map[string]string) {
	t.Helper()
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/kb.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
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

func kbReq(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
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

func TestAdminKB(t *testing.T) {
	r, db, hdr := kbAdminSetup(t)
	defer db.Close()

	// folder
	w, out := kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"产品文档"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create folder: %d %s", w.Code, w.Body.String())
	}
	folderID := int64(out["folder"].(map[string]any)["id"].(float64))
	// grant user alice
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw"); err != nil {
		t.Fatal(err)
	}
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID),
		`{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant: %d", w.Code)
	}
	accessible, err := serverstore.GetAccessibleFolderIDs(db, "alice", nil)
	if err != nil || len(accessible) != 2 { // folder 0 global + granted folder
		t.Fatalf("accessible = %v %v", accessible, err)
	}
	// upload doc
	w, out = kbReq(t, r, "POST", "/api/admin/kb/upload",
		fmt.Sprintf(`{"title":"知识库使用手册","content":"本手册介绍知识库的用法","folder_id":%d}`, folderID), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))
	// search preview finds it (admin search uses empty username → global)
	w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=知识", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("search: %d", w.Code)
	}
	results := out["results"].([]any)
	if len(results) == 0 {
		t.Fatal("search found nothing")
	}
	// delete doc
	w, _ = kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/documents/%d", docID), "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: %d", w.Code)
	}
	// audit log written
	logs, err := serverstore.ListAuditLogs(db, 10)
	if err != nil || len(logs) != 2 {
		t.Fatalf("audit logs = %v %v", logs, err)
	}
	// non-admin → 401 on login, and direct kb call without session → 401
	if w, _ := kbReq(t, r, "GET", "/api/admin/kb/folders", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("no session: %d", w.Code)
	}
}
