package knowledge

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func kbDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := serverstore.Open(filepath.Join(t.TempDir(), "kb.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := serverstore.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	return db
}

// seedDocs inserts folders/docs: aliceFolder has alice grant, bobFolder has
// bob grant. One doc per folder. Returns both folder ids.
func seedDocs(t *testing.T, db *sql.DB) (aliceFolder, bobFolder int64) {
	t.Helper()
	aliceFolder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, aliceFolder, "alice"); err != nil {
		t.Fatal(err)
	}
	bobFolder, err = serverstore.CreateKBFolder(db, "bob-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, bobFolder, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateKBDocument(db, aliceFolder, "知识库使用手册", "这是知识库的使用说明内容", "text", 0, "upload", "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateKBDocument(db, bobFolder, "机密文档", "只有 bob 能看的内容", "text", 0, "upload", "bob"); err != nil {
		t.Fatal(err)
	}
	return aliceFolder, bobFolder
}

func TestSearchChinesePrefix(t *testing.T) {
	db := kbDB(t)
	seedDocs(t, db)

	res, total, err := Search(db, "alice", nil, "知识", 1, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 1 || len(res) != 1 {
		t.Fatalf("total=%d res=%d, want 1/1", total, len(res))
	}
	if res[0].Title != "知识库使用手册" {
		t.Fatalf("title = %q", res[0].Title)
	}

	// mid-token query: FTS prefix fails, LIKE fallback must hit
	res, total, err = Search(db, "alice", nil, "手册", 1, 10)
	if err != nil {
		t.Fatalf("Search mid-token: %v", err)
	}
	if total != 1 || res[0].Title != "知识库使用手册" {
		t.Fatalf("mid-token total=%d res=%v, want 知识库使用手册", total, res)
	}
}

func TestSearchMaliciousQuery(t *testing.T) {
	db := kbDB(t)
	seedDocs(t, db)

	for _, q := range []string{`" OR ' --`, `知识 OR " --`, `*():"`, `a"b*c`} {
		res, total, err := Search(db, "alice", nil, q, 1, 10)
		if err != nil {
			t.Fatalf("Search(%q) errored: %v", q, err)
		}
		if res == nil {
			t.Fatalf("Search(%q) returned nil slice", q)
		}
		_ = total
	}

	// all-stripped query returns empty, not an error
	res, total, err := Search(db, "alice", nil, `"*():`, 1, 10)
	if err != nil || total != 0 || len(res) != 0 {
		t.Fatalf("stripped query: res=%v total=%d err=%v, want empty", res, total, err)
	}
}

func TestSearchPermissionFilter(t *testing.T) {
	db := kbDB(t)
	seedDocs(t, db)

	// alice must not see bob's doc
	res, total, err := Search(db, "alice", nil, "机密", 1, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 0 || len(res) != 0 {
		t.Fatalf("alice sees bob's doc: total=%d", total)
	}

	// bob sees his own
	res, total, _ = Search(db, "bob", nil, "机密", 1, 10)
	if total != 1 || len(res) != 1 {
		t.Fatalf("bob search: total=%d res=%d", total, len(res))
	}
}

func TestSearchPagination(t *testing.T) {
	db := kbDB(t)
	aliceFolder, _ := seedDocs(t, db)
	for i := 0; i < 4; i++ {
		if _, err := serverstore.CreateKBDocument(db, aliceFolder, "公共文档", "公共知识内容", "text", 0, "upload", "alice"); err != nil {
			t.Fatal(err)
		}
	}
	// alice has 5 accessible docs total
	res, total, err := Search(db, "alice", nil, "知识", 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 {
		t.Fatalf("total = %d, want 5", total)
	}
	if len(res) != 2 {
		t.Fatalf("page1 len = %d, want 2", len(res))
	}
	res, total, err = Search(db, "alice", nil, "知识", 3, 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 || len(res) != 1 {
		t.Fatalf("page3: total=%d len=%d, want 5/1", total, len(res))
	}
}

func TestIndexDocument(t *testing.T) {
	db := kbDB(t)
	aliceFolder, _ := seedDocs(t, db)

	// txt/md accepted as-is; docx/pdf extraction lands in task 4.2
	id, err := IndexDocument(db, aliceFolder, "读我", "这是读我文件的内容", "text", "upload", "alice")
	if err != nil || id == 0 {
		t.Fatalf("IndexDocument: %d %v", id, err)
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if err != nil || doc.Title != "读我" {
		t.Fatalf("GetKBDocument: %v %+v", err, doc)
	}
}
