package serverstore

import (
	"testing"
)

func TestSkillGrantsLifecycle(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	// grant user + group (idempotent)
	if err := GrantSkill(db, "data-extract", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	// '@' prefix is stripped (webadmin convention)
	if err := GrantSkill(db, "data-extract", "@bob", GranteeUser); err != nil {
		t.Fatal(err)
	}

	grants, err := ListSkillGrants(db, "data-extract")
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 3 {
		t.Fatalf("grants = %+v, want 3", grants)
	}

	// accessible: direct user + group membership
	names, err := AccessibleSkillNames(db, "alice", []string{"研发部"})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "data-extract" {
		t.Fatalf("accessible = %v", names)
	}
	// group-only access
	names, err = AccessibleSkillNames(db, "carl", []string{"研发部"})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 {
		t.Fatalf("group member accessible = %v", names)
	}
	// no grants at all → empty (strict default)
	names, err = AccessibleSkillNames(db, "nobody", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("strict default violated: %v", names)
	}

	// revoke: takes effect immediately
	if err := RevokeSkill(db, "data-extract", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	names, err = AccessibleSkillNames(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("after revoke alice still sees: %v", names)
	}

	// invalid grantee rejected
	if err := GrantSkill(db, "data-extract", "", GranteeUser); err != ErrValidation {
		t.Fatalf("empty grantee err = %v, want ErrValidation", err)
	}
	if err := GrantSkill(db, "data-extract", "a/b", GranteeUser); err != ErrValidation {
		t.Fatalf("path grantee err = %v, want ErrValidation", err)
	}

	// delete cascades (no resurrection on re-create)
	if err := DeleteSkillGrants(db, "data-extract"); err != nil {
		t.Fatal(err)
	}
	grants, _ = ListSkillGrants(db, "data-extract")
	if len(grants) != 0 {
		t.Fatalf("grants survived delete: %+v", grants)
	}
}

func TestMCPGrantsLifecycle(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if err := GrantMCP(db, 4, "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	if err := GrantMCP(db, 4, "研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	set, err := AccessibleMCPSet(db, "alice", []string{"研发部"})
	if err != nil {
		t.Fatal(err)
	}
	if !set[4] || len(set) != 1 {
		t.Fatalf("mcp set = %v", set)
	}
	set, err = AccessibleMCPSet(db, "nobody", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 0 {
		t.Fatalf("strict default violated: %v", set)
	}
	if err := RevokeMCP(db, 4, "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	set, _ = AccessibleMCPSet(db, "alice", nil)
	if len(set) != 0 {
		t.Fatalf("after revoke: %v", set)
	}
	if err := DeleteMCPGrants(db, 4); err != nil {
		t.Fatal(err)
	}
	grants, _ := ListMCPGrants(db, 4)
	if len(grants) != 0 {
		t.Fatalf("grants survived delete: %+v", grants)
	}
}

// 知识库根目录收紧:未授权用户不再默认可见 folder 0。
func TestGetAccessibleFolderIDsNoImplicitRoot(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	fid, err := CreateKBFolder(db, "研发部", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := GrantFolderUser(db, fid, "alice"); err != nil {
		t.Fatal(err)
	}
	// alice: only the granted folder — folder 0 is NOT implicitly included
	ids, err := GetAccessibleFolderIDs(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != fid {
		t.Fatalf("accessible = %v, want only %d", ids, fid)
	}
	// nobody: nothing at all
	ids, err = GetAccessibleFolderIDs(db, "nobody", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 0 {
		t.Fatalf("nobody sees: %v, want empty", ids)
	}
}
