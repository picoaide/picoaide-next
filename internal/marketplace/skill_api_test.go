package marketplace

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// newTestRouter builds a migrated DB with user alice, a registered token,
// and a marketplace router; returns router, db, token, api.
func newTestRouter(t *testing.T) (*gin.Engine, *sql.DB, string, *API) {
	t.Helper()
	db, err := serverstore.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "secret123")
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	api := NewAPI(db, filepath.Join(t.TempDir(), "skills-cache"))
	r := gin.New()
	api.RegisterRoutes(r)
	t.Cleanup(func() { db.Close() })
	return r, db, token, api
}

func doReq(r *gin.Engine, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func decodeJSON(t *testing.T, w *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
}

func hasErrCode(w *httptest.ResponseRecorder, code string) bool {
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		return false
	}
	return body.Error.Code == code
}

func TestSkillAPI(t *testing.T) {
	r, db, token, _ := newTestRouter(t)

	src := makeGitRepo(t, filepath.Join(t.TempDir(), "skill-src"))
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "demo", Version: "1.0.0", Description: "demo skill",
		Author: "pico", GitURL: src, GitRef: "main", Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "hidden", Version: "1.0.0", GitURL: src, Enabled: 0,
	}); err != nil {
		t.Fatal(err)
	}

	// list: enabled only
	w := doReq(r, "GET", "/api/marketplace/skills", token)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, body %s", w.Code, w.Body.String())
	}
	var list struct {
		Skills []map[string]any `json:"skills"`
	}
	decodeJSON(t, w, &list)
	if len(list.Skills) != 1 || list.Skills[0]["name"] != "demo" {
		t.Fatalf("list = %+v", list.Skills)
	}

	// detail
	w = doReq(r, "GET", "/api/marketplace/skills/demo", token)
	if w.Code != http.StatusOK {
		t.Fatalf("detail status = %d, body %s", w.Code, w.Body.String())
	}
	var det struct {
		Skill map[string]any `json:"skill"`
	}
	decodeJSON(t, w, &det)
	if det.Skill["version"] != "1.0.0" || det.Skill["description"] != "demo skill" {
		t.Fatalf("detail = %+v", det.Skill)
	}

	// unknown skill -> 404
	w = doReq(r, "GET", "/api/marketplace/skills/nope", token)
	if w.Code != http.StatusNotFound || !hasErrCode(w, "NOT_FOUND") {
		t.Fatalf("unknown skill = %d, body %s", w.Code, w.Body.String())
	}

	// archive: downloads a valid tar.gz with version header
	w = doReq(r, "GET", "/api/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("archive status = %d, body %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/gzip" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if v := w.Header().Get("X-Skill-Version"); v != "1.0.0" {
		t.Fatalf("X-Skill-Version = %q", v)
	}
	// checksum: sha256 of the served body, persisted to the skills row
	sum := sha256.Sum256(w.Body.Bytes())
	want := hex.EncodeToString(sum[:])
	if cs := w.Header().Get("X-Skill-Checksum"); cs != want {
		t.Fatalf("X-Skill-Checksum = %q, want %q", cs, want)
	}
	got, err := serverstore.GetSkill(db, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if got.Checksum != want {
		t.Fatalf("persisted checksum = %q, want %q", got.Checksum, want)
	}
	names := tarNames(t, w.Body.Bytes())
	if !names["metadata.yaml"] || !names["SKILL.md"] {
		t.Fatalf("archive entries = %v", names)
	}
	// second request: cache hit, same checksum
	w = doReq(r, "GET", "/api/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("archive cache status = %d", w.Code)
	}
	if cs := w.Header().Get("X-Skill-Checksum"); cs != want {
		t.Fatalf("cache checksum = %q, want %q", cs, want)
	}

	// no token -> 401 on every endpoint
	for _, p := range []string{"/api/marketplace/skills", "/api/marketplace/skills/demo", "/api/marketplace/skills/demo/archive"} {
		if w := doReq(r, "GET", p, ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("no-token %s = %d", p, w.Code)
		}
	}
}

func tarNames(t *testing.T, data []byte) map[string]bool {
	t.Helper()
	gr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gr)
	names := map[string]bool{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names[hdr.Name] = true
	}
	return names
}
