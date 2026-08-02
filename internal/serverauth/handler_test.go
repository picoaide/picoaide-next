package serverauth

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

func newTestAPI(t *testing.T) (*gin.Engine, *sql.DB, func()) {
	t.Helper()
	db, err := serverstore.EnsureMigrated(tempPath(t, "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	r := gin.New()
	api.RegisterRoutes(r)
	cleanup := func() { db.Close() }
	return r, db, cleanup
}

func tempPath(t *testing.T, name string) string {
	t.Helper()
	return fmt.Sprintf("%s/%s", t.TempDir(), name)
}

func createUser(t *testing.T, db *sql.DB, username, password string, admin bool) {
	t.Helper()
	_, err := serverstore.CreateUserWithPassword(db, username, password)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, username)
	u.IsAdmin = admin
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
}

func doJSON(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
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

func TestLoginLogoutMe(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "admin", "Admin@123", true)

	// wrong password
	w, out := doJSON(t, r, "POST", "/api/auth/login", `{"username":"admin","password":"bad"}`, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong pw status = %d, body=%s", w.Code, w.Body.String())
	}
	if code, _ := out["error"].(map[string]any)["code"].(string); code != "AUTH_FAILED" {
		t.Fatalf("code = %v", out["error"])
	}

	// correct login
	w, out = doJSON(t, r, "POST", "/api/auth/login", `{"username":"admin","password":"Admin@123"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", w.Code, w.Body.String())
	}
	token := out["token"].(string)
	if token == "" {
		t.Fatal("empty token")
	}

	// me
	w, out = doJSON(t, r, "GET", "/api/auth/me", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("me status = %d body=%s", w.Code, w.Body.String())
	}
	if u := out["user"].(map[string]any); u["username"] != "admin" {
		t.Fatalf("me user = %v", u)
	}

	// logout revokes
	w, _ = doJSON(t, r, "POST", "/api/auth/logout", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("logout status = %d", w.Code)
	}
	w, _ = doJSON(t, r, "GET", "/api/auth/me", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("me after logout status = %d", w.Code)
	}
}

func TestBearerAuthRequired(t *testing.T) {
	r, _, cleanup := newTestAPI(t)
	defer cleanup()
	w, _ := doJSON(t, r, "GET", "/api/auth/me", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d", w.Code)
	}
}

func TestLoginRateLimit(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "admin", "Admin@123", false)

	status := http.StatusOK
	for i := 0; i < 15; i++ {
		w, out := doJSON(t, r, "POST", "/api/auth/login", `{"username":"admin","password":"wrong"}`, nil)
		status = w.Code
		if status == http.StatusTooManyRequests {
			if code, _ := out["error"].(map[string]any)["code"].(string); code != "RATE_LIMITED" {
				t.Fatalf("rate limit code = %v", out)
			}
			break
		}
	}
	if status != http.StatusTooManyRequests {
		t.Fatalf("expected rate limit after 10 attempts, last status = %d", status)
	}
}

func TestBootstrapAdmin(t *testing.T) {
	db, err := serverstore.EnsureMigrated(tempPath(t, "boot.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// missing env -> error
	t.Setenv("PICOAI_ADMIN_PASSWORD", "")
	if err := EnsureBootstrapAdmin(db, "boss"); err == nil {
		t.Fatal("expected error without password env")
	}

	t.Setenv("PICOAI_ADMIN_PASSWORD", "Secret@99")
	if err := EnsureBootstrapAdmin(db, "boss"); err != nil {
		t.Fatalf("EnsureBootstrapAdmin: %v", err)
	}
	u, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil || !u.IsAdmin {
		t.Fatalf("boss not admin: %v %+v", err, u)
	}
	if util.VerifyPassword(u.PasswordHash, "Secret@99") == false {
		t.Fatal("bootstrap password not set correctly")
	}

	// idempotent: existing admin -> no error, no change
	if err := EnsureBootstrapAdmin(db, "boss"); err != nil {
		t.Fatalf("second EnsureBootstrapAdmin: %v", err)
	}
}
