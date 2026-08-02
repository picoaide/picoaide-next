package serverstore

import (
	"errors"
	"testing"
	"time"
)

func TestMCPServers(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := AddMCPServer(db, &MCPServer{
		Name: "files", Description: "files mcp",
		Transport: "stdio", Command: "node", Args: []string{"server.js"},
		Env:     map[string]string{"TOKEN": "enc:v1:abc"},
		Headers: map[string]string{"Authorization": "Bearer x"},
		Enabled: 1,
	})
	if err != nil || id == 0 {
		t.Fatalf("AddMCPServer: id=%d err=%v", id, err)
	}
	// no unique constraint on name
	id2, err := AddMCPServer(db, &MCPServer{Name: "files", Transport: "stdio", Enabled: 0})
	if err != nil || id2 == 0 {
		t.Fatalf("AddMCPServer#2: id=%d err=%v", id2, err)
	}

	m, err := GetMCPServer(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "files" || m.Transport != "stdio" || len(m.Args) != 1 || m.Args[0] != "server.js" ||
		m.Env["TOKEN"] != "enc:v1:abc" || m.Headers["Authorization"] != "Bearer x" || m.Enabled != 1 {
		t.Fatalf("GetMCPServer = %+v", m)
	}

	m.Description = "updated"
	m.Enabled = 0
	if err := UpdateMCPServer(db, m); err != nil {
		t.Fatal(err)
	}
	m, _ = GetMCPServer(db, id)
	if m.Description != "updated" || m.Enabled != 0 {
		t.Fatalf("after update = %+v", m)
	}

	// re-enable so list checks are meaningful
	m.Enabled = 1
	_ = UpdateMCPServer(db, m)
	list, err := ListMCPServers(db, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("enabled list = %+v", list)
	}
	all, err := ListMCPServers(db, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("all list = %+v", all)
	}

	// downloads audit
	uid, err := CreateUserWithPassword(db, "alice", "secret123")
	if err != nil {
		t.Fatal(err)
	}
	if err := RecordDownload(db, uid, id); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	rows, err := ListDownloads(db, uid, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].MCPID != id || rows[0].UserID != uid {
		t.Fatalf("downloads = %+v", rows)
	}
	rows, _ = ListDownloads(db, uid, now.Add(-time.Hour), now.Add(-30*time.Minute))
	if len(rows) != 0 {
		t.Fatalf("downloads in past window = %+v", rows)
	}

	// row delete
	if err := DeleteMCPServer(db, id2); err != nil {
		t.Fatal(err)
	}
	if _, err := GetMCPServer(db, id2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete err = %v, want ErrNotFound", err)
	}
	if err := DeleteMCPServer(db, id2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete twice err = %v, want ErrNotFound", err)
	}
}
