package knowledge

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
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

// kbMultipart posts a multipart upload to /api/admin/kb/upload.
func kbMultipart(t *testing.T, r http.Handler, fields map[string]string, fileName string, data []byte, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	fw, err := mw.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatal(err)
	}
	fw.Write(data)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/admin/kb/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

// minimalDocx builds a docx archive containing one word/document.xml.
func minimalDocx(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestAdminKBRevokeGrant(t *testing.T) {
	r, db, hdr := kbAdminSetup(t)
	defer db.Close()

	w, out := kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"产品文档"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create folder: %d", w.Code)
	}
	folderID := int64(out["folder"].(map[string]any)["id"].(float64))
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw"); err != nil {
		t.Fatal(err)
	}
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant: %d", w.Code)
	}
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"group":"devs"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant group: %d", w.Code)
	}
	// list grants
	w, out = kbReq(t, r, "GET", fmt.Sprintf("/api/admin/kb/folders/%d/grants", folderID), "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list grants: %d %s", w.Code, w.Body.String())
	}
	users := out["users"].([]any)
	groups := out["groups"].([]any)
	if len(users) != 1 || users[0] != "alice" || len(groups) != 1 || groups[0] != "devs" {
		t.Fatalf("grants = %v %v", users, groups)
	}
	// revoke user grant → permission check drops the folder immediately
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("revoke: %d", w.Code)
	}
	accessible, err := serverstore.GetAccessibleFolderIDs(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range accessible {
		if id == folderID {
			t.Fatal("alice still has access after revoke")
		}
	}
	// revoke again (idempotent) and missing body validation
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("revoke twice: %d", w.Code)
	}
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("revoke empty body: %d", w.Code)
	}
	// revoke group grant
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"group":"devs"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("revoke group: %d", w.Code)
	}
	w, out = kbReq(t, r, "GET", fmt.Sprintf("/api/admin/kb/folders/%d/grants", folderID), "", hdr)
	if len(out["users"].([]any)) != 0 || len(out["groups"].([]any)) != 0 {
		t.Fatalf("grants after revoke = %v", out)
	}
}

func TestAdminKBDocUpdate(t *testing.T) {
	r, db, hdr := kbAdminSetup(t)
	defer db.Close()

	w, out := kbReq(t, r, "POST", "/api/admin/kb/upload",
		`{"title":"变更日志","content":"旧版本功能描述","content_type":"text","folder_id":0}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))

	// fetch single doc for editing
	w, out = kbReq(t, r, "GET", fmt.Sprintf("/api/admin/kb/documents/%d", docID), "", hdr)
	if w.Code != http.StatusOK || out["doc"].(map[string]any)["content"] != "旧版本功能描述" {
		t.Fatalf("get doc: %d %s", w.Code, w.Body.String())
	}
	// update title + content
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/documents/%d", docID),
		`{"title":"更新日志","content":"全新特性描述"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	// new content searchable, old content gone, title updated
	if w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=全新特性", "", hdr); w.Code != http.StatusOK || len(out["results"].([]any)) != 1 {
		t.Fatalf("search new content: %d %s", w.Code, w.Body.String())
	}
	if w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=旧版本功能", "", hdr); w.Code != http.StatusOK || len(out["results"].([]any)) != 0 {
		t.Fatalf("search old content: %d %s", w.Code, w.Body.String())
	}
	w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=更新日志", "", hdr)
	if w.Code != http.StatusOK || len(out["results"].([]any)) != 1 || out["results"].([]any)[0].(map[string]any)["title"] != "更新日志" {
		t.Fatalf("search title: %d %s", w.Code, w.Body.String())
	}
	// audit log entry written for the update
	logs, err := serverstore.ListAuditLogs(db, 10)
	if err != nil || len(logs) != 2 {
		t.Fatalf("audit logs = %v %v", logs, err)
	}
	// validation: empty title, nonexistent id, oversized content
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/documents/%d", docID), `{"title":"","content":"x"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("empty title: %d", w.Code)
	}
	if w, _ := kbReq(t, r, "PUT", "/api/admin/kb/documents/99999", `{"title":"t","content":"x"}`, hdr); w.Code != http.StatusNotFound {
		t.Fatalf("nonexistent: %d", w.Code)
	}
	big := strings.Repeat("字", (1<<20)+1)
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/documents/%d", docID), `{"title":"t","content":"`+big+`"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("oversized: %d", w.Code)
	}
}

func TestAdminKBUploadMultipartTxt(t *testing.T) {
	r, db, hdr := kbAdminSetup(t)
	defer db.Close()

	content := "第一条需求是支持多文件上传"
	w, out := kbMultipart(t, r, map[string]string{"title": "需求文档", "folder_id": "0"}, "需求.txt", []byte(content), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("txt upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))
	doc, err := serverstore.GetKBDocument(db, docID)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Content != content || doc.Size != int64(len(content)) {
		t.Fatalf("doc = %+v", doc)
	}
	// title missing → defaults to filename
	w, out = kbMultipart(t, r, map[string]string{"folder_id": "0"}, "默认标题.txt", []byte("备用内容"), hdr)
	if w.Code != http.StatusOK || out["doc"].(map[string]any)["title"] != "默认标题.txt" {
		t.Fatalf("default title: %d %s", w.Code, w.Body.String())
	}
	// extractable via admin search (LIKE fallback)
	if w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=多文件上传", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("search: %d", w.Code)
	}
	if len(out["results"].([]any)) == 0 {
		t.Fatal("search found nothing")
	}
}

func TestAdminKBUploadMultipartDocx(t *testing.T) {
	r, db, hdr := kbAdminSetup(t)
	defer db.Close()

	docx := minimalDocx(t, `<?xml version="1.0"?><w:document><w:body>
		<w:p><w:r><w:t>Docx 第一段内容</w:t></w:r></w:p>
		<w:p><w:r><w:t>A &amp; B 第二段</w:t></w:r></w:p>
	</w:body></w:document>`)
	w, out := kbMultipart(t, r, map[string]string{"title": "产品说明", "folder_id": "0"}, "说明.docx", docx, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("docx upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))
	doc, err := serverstore.GetKBDocument(db, docID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(doc.Content, "Docx 第一段内容") || !strings.Contains(doc.Content, "A & B 第二段") {
		t.Fatalf("extracted = %q", doc.Content)
	}
	if doc.ContentType != "docx" {
		t.Fatalf("content type = %q", doc.ContentType)
	}
	// broken zip → clear validation error
	if w, _ := kbMultipart(t, r, map[string]string{"title": "坏文件"}, "坏.docx", []byte("not a zip"), hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad docx: %d %s", w.Code, w.Body.String())
	}
}

func TestAdminKBUploadMultipartPDFErrors(t *testing.T) {
	r, _, hdr := kbAdminSetup(t)
	// a garbage pdf must fail with a clear VALIDATION error, not a 500
	// (a hand-built pdf with a valid xref table is not worth maintaining;
	// ledongthuc/pdf's text path is exercised in its own repo)
	w, out := kbMultipart(t, r, map[string]string{"title": "假pdf"}, "假.pdf", []byte("%PDF-1.4\ngarbage"), hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad pdf: %d %s", w.Code, w.Body.String())
	}
	errObj, ok := out["error"].(map[string]any)
	if !ok || errObj["code"] != "VALIDATION" || !strings.Contains(errObj["message"].(string), "pdf") {
		t.Fatalf("bad pdf error = %v", out)
	}
	// unsupported extension
	if w, _ := kbMultipart(t, r, map[string]string{"title": "病毒"}, "evil.exe", []byte("MZ"), hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad ext: %d", w.Code)
	}
}

func TestAdminKBPagedDocsAndAudit(t *testing.T) {
	r, db, hdr := kbAdminSetup(t)
	defer db.Close()
	for i := 0; i < 5; i++ {
		if w, _ := kbReq(t, r, "POST", "/api/admin/kb/upload",
			fmt.Sprintf(`{"title":"文档%d","content":"内容%d","folder_id":0}`, i, i), hdr); w.Code != http.StatusOK {
			t.Fatalf("upload %d: %d", i, w.Code)
		}
	}
	// paginated documents: page 2 size 2 → 2 docs, total 5
	w, out := kbReq(t, r, "GET", "/api/admin/kb/documents?folder_id=0&page=2&size=2", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("docs: %d", w.Code)
	}
	if total := out["total"].(float64); total != 5 {
		t.Fatalf("total = %v", total)
	}
	if docs := out["documents"].([]any); len(docs) != 2 || docs[0].(map[string]any)["title"] != "文档2" {
		t.Fatalf("docs = %v", docs)
	}
	// audit endpoint lists uploads newest first, paged
	w, out = kbReq(t, r, "GET", "/api/admin/kb/audit?page=1&size=3", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("audit: %d", w.Code)
	}
	if total := out["total"].(float64); total != 5 {
		t.Fatalf("audit total = %v", total)
	}
	logs := out["logs"].([]any)
	if len(logs) != 3 || logs[0].(map[string]any)["action"] != "kb_upload" {
		t.Fatalf("logs = %v", logs)
	}
}
