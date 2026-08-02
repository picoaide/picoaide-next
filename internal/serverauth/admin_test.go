package serverauth

import (
	"database/sql"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestAdminSession(t *testing.T) {
	db := mustDB(t)
	uid, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if sess.ID == "" || csrf == "" {
		t.Fatal("empty session/csrf")
	}
	u, err := ValidateAdminSession(db, sess.ID)
	if err != nil || u.ID != uid {
		t.Fatalf("validate: %v %v", u, err)
	}
	// csrf verify with tolerance (deterministic: anchored at an hour boundary)
	anchor := time.Now().UTC().Truncate(time.Hour)
	tok := IssueCSRF(sess.CSRFKey, anchor)
	if !VerifyCSRF(sess.CSRFKey, tok, anchor.Add(30*time.Minute)) {
		t.Fatal("same-window token rejected")
	}
	if !VerifyCSRF(sess.CSRFKey, tok, anchor.Add(90*time.Minute)) {
		t.Fatal("next-window token rejected")
	}
	if VerifyCSRF(sess.CSRFKey, tok, anchor.Add(150*time.Minute)) {
		t.Fatal("stale token accepted")
	}
	tokPrev := IssueCSRF(sess.CSRFKey, anchor.Add(-30*time.Minute))
	if !VerifyCSRF(sess.CSRFKey, tokPrev, anchor.Add(30*time.Minute)) {
		t.Fatal("previous-window token rejected")
	}
	if VerifyCSRF(sess.CSRFKey, "bad", anchor) {
		t.Fatal("csrf accepted bad token")
	}
	if VerifyCSRF("other-key", tok, anchor) {
		t.Fatal("csrf accepted wrong key")
	}
	// expire
	_, err = db.Exec("UPDATE admin_sessions SET expires_at = ? WHERE id = ?", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateAdminSession(db, sess.ID); err == nil {
		t.Fatal("expired session accepted")
	}
}

func TestAdminAPIs(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()

	// login
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	csrf := out["csrf_token"].(string)
	cookies := w.Result().Cookies()
	var sess string
	for _, ck := range cookies {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	if sess == "" {
		t.Fatal("no session cookie")
	}
	if !cookieHttpOnly(cookies) {
		t.Fatal("cookie not HttpOnly")
	}
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}

	// list users requires auth
	if w, _ := doJSON(t, r, "GET", "/api/admin/users", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("users without session: %d", w.Code)
	}
	// create user
	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"alicepw","is_admin":false}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("create user: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["user"].(map[string]any)["id"].(float64))
	// update user
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"status":0}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("update user: %d %s", w.Code, w.Body.String())
	}
	// CSRF missing → 403
	if w, _ := doJSON(t, r, "POST", "/api/admin/users", `{"username":"eve","password":"x"}`, map[string]string{"Cookie": "picoaide_session=" + sess}); w.Code != http.StatusForbidden {
		t.Fatalf("create without csrf: %d", w.Code)
	}
	// delete user
	w, _ = doJSON(t, r, "DELETE", fmt.Sprintf("/api/admin/users/%d", id), "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("delete user: %d %s", w.Code, w.Body.String())
	}
	// cannot delete self
	w, _ = doJSON(t, r, "DELETE", "/api/admin/users/1", "", hdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("delete self: %d", w.Code)
	}
	// logout
	w, _ = doJSON(t, r, "POST", "/api/admin/logout", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("logout: %d", w.Code)
	}
	if w, _ := doJSON(t, r, "GET", "/api/admin/users", "", hdr()); w.Code != http.StatusUnauthorized {
		t.Fatalf("users after logout: %d", w.Code)
	}
}

func TestAdminUsage(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}

	// record some usage for user 1
	recordUsage(t, db, 1, "deepseek-chat", 10, 20)
	recordUsage(t, db, 1, "deepseek-chat", 30, 40)

	w, out = doJSON(t, r, "GET", "/api/admin/usage?group=day", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("usage: %d %s", w.Code, w.Body.String())
	}
	rows := out["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("usage rows = %d", len(rows))
	}
	r0 := rows[0].(map[string]any)
	if r0["prompt_tokens"].(float64) != 40 || r0["requests"].(float64) != 2 {
		t.Fatalf("usage row = %v", r0)
	}
	// invalid group
	if w, _ := doJSON(t, r, "GET", "/api/admin/usage?group=nope", "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad group: %d", w.Code)
	}
}

// --- helpers ---

func mustDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := serverstore.EnsureMigrated(tempPath(t, "admin.db"))
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func createUserDB(db *sql.DB, username, password string, admin bool) (int64, error) {
	id, err := serverstore.CreateUserWithPassword(db, username, password)
	if err != nil {
		return 0, err
	}
	u, err := serverstore.GetUserByID(db, id)
	if err != nil {
		return 0, err
	}
	u.IsAdmin = admin
	return id, serverstore.UpdateUser(db, u)
}

func adminRouter(t *testing.T) (http.Handler, *sql.DB) {
	t.Helper()
	db := mustDB(t)
	if _, err := createUserDB(db, "boss", "pw123456", true); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)
	return r, db
}

func cookieHttpOnly(cookies []*http.Cookie) bool {
	for _, ck := range cookies {
		if ck.Name == sessionCookieName {
			return ck.HttpOnly
		}
	}
	return false
}

func recordUsage(t *testing.T, db *sql.DB, userID int64, model string, pt, ct int64) {
	t.Helper()
	_, err := serverstore.RecordUsage(db, userID, model, pt, ct)
	if err != nil {
		t.Fatal(err)
	}
}
