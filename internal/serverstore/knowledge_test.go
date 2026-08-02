package serverstore

import (
	"errors"
	"testing"
)

func TestKBCrud(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	fid, err := CreateKBFolder(db, "研发文档", 0)
	if err != nil || fid == 0 {
		t.Fatalf("CreateKBFolder: %d %v", fid, err)
	}
	did, err := CreateKBDocument(db, fid, "知识库使用手册", "这是知识库的使用说明内容", "text", 0, "upload", "alice")
	if err != nil || did == 0 {
		t.Fatalf("CreateKBDocument: %d %v", did, err)
	}

	doc, err := GetKBDocument(db, did)
	if err != nil {
		t.Fatalf("GetKBDocument: %v", err)
	}
	if doc.FolderID != fid || doc.Title != "知识库使用手册" || doc.CreatedBy != "alice" || doc.Size != int64(len("这是知识库的使用说明内容")) {
		t.Fatalf("doc = %+v", doc)
	}

	folders, err := ListKBFolders(db)
	if err != nil || len(folders) != 1 || folders[0].Name != "研发文档" {
		t.Fatalf("ListKBFolders: %v %v", folders, err)
	}

	if err := DeleteKBDocument(db, did); err != nil {
		t.Fatalf("DeleteKBDocument: %v", err)
	}
	if _, err := GetKBDocument(db, did); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetKBDocument after delete: %v, want ErrNotFound", err)
	}
	if err := DeleteKBDocument(db, did); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteKBDocument twice: %v, want ErrNotFound", err)
	}
}

func TestKBPermissions(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	f1, _ := CreateKBFolder(db, "team-a", 0)
	f2, _ := CreateKBFolder(db, "team-b", 0)
	f3, _ := CreateKBFolder(db, "ops", 0)

	if err := GrantFolderUser(db, f1, "alice"); err != nil {
		t.Fatalf("GrantFolderUser: %v", err)
	}
	if err := GrantFolderGroup(db, f2, "devs"); err != nil {
		t.Fatalf("GrantFolderGroup: %v", err)
	}

	acc := map[int64]bool{}
	ids, err := GetAccessibleFolderIDs(db, "alice", []string{"devs"})
	if err != nil {
		t.Fatalf("GetAccessibleFolderIDs: %v", err)
	}
	for _, id := range ids {
		acc[id] = true
	}
	for _, want := range []int64{0, f1, f2} {
		if !acc[want] {
			t.Errorf("folder %d not accessible", want)
		}
	}
	if acc[f3] {
		t.Errorf("folder %d should not be accessible", f3)
	}

	// without the group, f2 is not accessible
	acc = map[int64]bool{}
	ids, _ = GetAccessibleFolderIDs(db, "alice", nil)
	for _, id := range ids {
		acc[id] = true
	}
	if acc[f2] {
		t.Errorf("folder %d accessible without group", f2)
	}
	if !acc[f1] || !acc[0] {
		t.Errorf("direct grant or global folder lost")
	}

	// different user without grants only sees the global folder
	ids, _ = GetAccessibleFolderIDs(db, "bob", nil)
	if len(ids) != 1 || ids[0] != 0 {
		t.Fatalf("bob accessible = %v, want [0]", ids)
	}
}

func TestKBAuditLog(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if err := AuditLog(db, "alice", "kb_upload", "folder=1 title=x"); err != nil {
		t.Fatalf("AuditLog: %v", err)
	}
	logs, err := ListAuditLogs(db, 10)
	if err != nil || len(logs) != 1 {
		t.Fatalf("ListAuditLogs: %v %v", logs, err)
	}
	if logs[0].Username != "alice" || logs[0].Action != "kb_upload" || logs[0].Detail != "folder=1 title=x" {
		t.Fatalf("log = %+v", logs[0])
	}
}
