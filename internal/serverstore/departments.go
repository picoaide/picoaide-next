package serverstore

import (
	"database/sql"
	"errors"
	"strings"
)

// Group is an organization unit: a department with optional parent
// (pyramid) and leader (department head).
type Group struct {
	ID          int64
	Name        string
	ParentID    int64
	LeaderID    int64
	Description string
}

// DepartmentInfo is the admin-view shape of a department.
type DepartmentInfo struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	ParentID    int64  `json:"parent_id"`
	LeaderID    int64  `json:"leader_id"`
	LeaderName  string `json:"leader_name,omitempty"`
	Description string `json:"description"`
	MemberCount int64  `json:"member_count"`
	ChildCount  int64  `json:"child_count"`
	// GrantedCount counts grant references (kb/skill/mcp) — deletion guard.
	GrantedCount int64 `json:"granted_count"`
}

// ListDepartments returns every department with admin-view fields.
func ListDepartments(db *sql.DB) ([]DepartmentInfo, error) {
	rows, err := db.Query(`SELECT g.id, g.name, g.parent_id, g.leader_id, g.description,
		COALESCE(u.username, ''),
		(SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id),
		(SELECT COUNT(*) FROM groups c WHERE c.parent_id = g.id),
		(SELECT COUNT(*) FROM kb_folder_groups kfg WHERE kfg.group_id = g.id)
		+ (SELECT COUNT(*) FROM skill_grants sg WHERE sg.grantee_type = 'group' AND sg.grantee = g.name COLLATE NOCASE)
		+ (SELECT COUNT(*) FROM mcp_grants mg WHERE mg.grantee_type = 'group' AND mg.grantee = g.name COLLATE NOCASE)
		FROM groups g LEFT JOIN users u ON u.id = g.leader_id
		ORDER BY g.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DepartmentInfo
	for rows.Next() {
		var d DepartmentInfo
		if err := rows.Scan(&d.ID, &d.Name, &d.ParentID, &d.LeaderID, &d.Description,
			&d.LeaderName, &d.MemberCount, &d.ChildCount, &d.GrantedCount); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GroupByID returns one group.
func GroupByID(db *sql.DB, id int64) (*Group, error) {
	row := db.QueryRow(`SELECT id, name, parent_id, leader_id, description FROM groups WHERE id = ?`, id)
	var g Group
	err := row.Scan(&g.ID, &g.Name, &g.ParentID, &g.LeaderID, &g.Description)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &g, err
}

// CreateDepartment inserts a department (parent_id 0 = top level).
// The parent must exist; duplicate names are rejected (UNIQUE, NOCASE since 0019).
// leader 必须存在(与 UpdateDepartment 同口径,防悬空主管静默落库)。
func CreateDepartment(db *sql.DB, name string, parentID, leaderID int64, description string) (int64, error) {
	if name == EveryoneGroupName {
		return 0, ErrValidation // 保留名:隐式全员组不可重建/改名占用
	}
	if name == "" {
		return 0, ErrValidation
	}
	if parentID != 0 {
		if _, err := GroupByID(db, parentID); err != nil {
			return 0, err
		}
	}
	if leaderID != 0 {
		if _, err := GetUserByID(db, leaderID); err != nil {
			return 0, err
		}
	}
	res, err := db.Exec(`INSERT INTO groups (name, parent_id, leader_id, description) VALUES (?, ?, ?, ?)`,
		name, parentID, leaderID, description)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateDepartment renames/reparents/re-leads a department.
// Guards: parent must exist and not be the department itself or a
// descendant (cycle); leader must exist. Renames cascade to the grant
// tables so existing grants keep resolving (授权按组名,改名不得静默失效).
func UpdateDepartment(db *sql.DB, id int64, name string, parentID, leaderID int64, description string) error {
	g, err := GroupByID(db, id)
	if err != nil {
		return err
	}
	if parentID != 0 {
		if parentID == id {
			return ErrValidation
		}
		sub, err := subtreeGroupIDs(db, id)
		if err != nil {
			return err
		}
		for _, s := range sub {
			if s == parentID {
				return ErrValidation
			}
		}
		if _, err := GroupByID(db, parentID); err != nil {
			return err
		}
	}
	if leaderID != 0 {
		if _, err := GetUserByID(db, leaderID); err != nil {
			return err
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if name == EveryoneGroupName {
		return ErrValidation // 保留名
	}
	if name == "" {
		return ErrValidation // 空名会把全部授权级联写成空串,store 层兜底拒绝
	}
	if name != "" && name != g.Name {
		// COLLATE NOCASE 与授权解析一致:授权存储大小写异于组名的(手输/LDAP)改名后不失效
		if _, err := tx.Exec("UPDATE skill_grants SET grantee = ? WHERE grantee_type = 'group' AND grantee = ? COLLATE NOCASE", name, g.Name); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE mcp_grants SET grantee = ? WHERE grantee_type = 'group' AND grantee = ? COLLATE NOCASE", name, g.Name); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`UPDATE groups SET name = ?, parent_id = ?, leader_id = ?, description = ? WHERE id = ?`,
		name, parentID, leaderID, description, id)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrDuplicate
		}
		return err
	}
	return tx.Commit()
}

// DeleteDepartment removes a department. Guard: departments with members,
// child departments or grant references cannot be deleted — the operator
// must move members/children and clear grants first (避免误删权限黑洞).
// 守卫计数与删除同事务(TOCTOU);授权引用按 NOCASE 计数(与解析口径一致,
// 大小写变体的授权不得绕过守卫导致孤儿授权/后续复活)。
func DeleteDepartment(db *sql.DB, id int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if g, err := GroupByID(db, id); err == nil && g.Name == EveryoneGroupName {
		return ErrValidation // 保留名
	}
	var memberCount, childCount, grantCount int64
	if err := tx.QueryRow(`SELECT
		(SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id),
		(SELECT COUNT(*) FROM groups c WHERE c.parent_id = g.id),
		(SELECT COUNT(*) FROM kb_folder_groups kfg WHERE kfg.group_id = g.id)
		+ (SELECT COUNT(*) FROM skill_grants sg WHERE sg.grantee_type = 'group' AND sg.grantee = g.name COLLATE NOCASE)
		+ (SELECT COUNT(*) FROM mcp_grants mg WHERE mg.grantee_type = 'group' AND mg.grantee = g.name COLLATE NOCASE)
		FROM groups g WHERE g.id = ?`, id).Scan(&memberCount, &childCount, &grantCount); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if memberCount > 0 || childCount > 0 || grantCount > 0 {
		return ErrDepartmentInUse
	}
	if _, err := tx.Exec("DELETE FROM groups WHERE id = ?", id); err != nil {
		return err
	}
	return tx.Commit()
}

// subtreeGroupIDs returns the department id plus all descendant ids
// (in-memory walk; the tree is small).
func subtreeGroupIDs(db *sql.DB, rootID int64) ([]int64, error) {
	rows, err := db.Query("SELECT id, parent_id FROM groups")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	children := map[int64][]int64{}
	for rows.Next() {
		var id, parent int64
		if err := rows.Scan(&id, &parent); err != nil {
			return nil, err
		}
		children[parent] = append(children[parent], id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []int64{rootID}
	stack := []int64{rootID}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, c := range children[cur] {
			out = append(out, c)
			stack = append(stack, c)
		}
	}
	return out, nil
}
