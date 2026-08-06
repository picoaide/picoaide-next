package knowledge

import (
	"database/sql"
	"fmt"
	"strings"
	"unicode"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// SearchResult is one knowledge base hit.
type SearchResult struct {
	ID          int64   `json:"id"`
	FolderID    int64   `json:"folder_id"`
	Title       string  `json:"title"`
	Content     string  `json:"content"`
	ContentType string  `json:"content_type"`
	Size        int64   `json:"size"`
	Source      string  `json:"source"`
	CreatedBy   string  `json:"created_by"`
	Score       float64 `json:"score"` // bm25 for FTS hits, 0 for LIKE-only hits
}

// sanitizeWord strips FTS5 syntax characters and control chars so a raw
// query word can never break out of a quoted phrase or alter the query.
func sanitizeWord(w string) string {
	return strings.Map(func(r rune) rune {
		if strings.ContainsRune("\"*():%_\\", r) || unicode.IsControl(r) {
			return -1
		}
		return r
	}, w)
}

// Search queries the knowledge base for docs the user can access.
//
// FTS5 unicode61 treats a run of hanzi as a single token, so a phrase query
// only matches when the phrase is a prefix of that token. Search therefore
// runs an FTS5 prefix MATCH ("word"*) plus a LIKE fallback over title/content
// for recall; hits are deduped, FTS hits first ordered by bm25, LIKE-only
// hits appended after.
func Search(db *sql.DB, username string, groups []string, query string, page, pageSize int) ([]SearchResult, int64, error) {
	folders, err := serverstore.GetAccessibleFolderIDs(db, username, groups)
	if err != nil {
		return nil, 0, err
	}
	return searchInFolders(db, folders, query, page, pageSize)
}

// SearchAll searches every folder (admin preview).
func SearchAll(db *sql.DB, query string, page, pageSize int) ([]SearchResult, int64, error) {
	folders, err := serverstore.ListKBFolders(db)
	if err != nil {
		return nil, 0, err
	}
	ids := make([]int64, 0, len(folders)+1)
	ids = append(ids, 0) // global root
	for _, f := range folders {
		ids = append(ids, f.ID)
	}
	return searchInFolders(db, ids, query, page, pageSize)
}

func searchInFolders(db *sql.DB, folders []int64, query string, page, pageSize int) ([]SearchResult, int64, error) {
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}

	var words []string
	for _, w := range strings.Fields(query) {
		if w = sanitizeWord(w); w != "" {
			words = append(words, w)
		}
	}
	if len(words) == 0 {
		return []SearchResult{}, 0, nil
	}

	// ponytail: folder list is small; IN (...) built from placeholders
	in := strings.TrimSuffix(strings.Repeat("?,", len(folders)), ",")
	inArgs := func() []any {
		a := make([]any, len(folders))
		for i, f := range folders {
			a[i] = f
		}
		return a
	}

	ftsQuery := make([]string, len(words))
	for i, w := range words {
		ftsQuery[i] = `"` + w + `"*`
	}
	ftsMatch := strings.Join(ftsQuery, " ")

	// One deduped predicate drives both the COUNT and the page query (C-5):
	// a doc matches when it hits the FTS query (subquery on rowid) or LIKE
	// matches every word. Pagination and total therefore agree exactly.
	conds := make([]string, len(words))
	likeArgs := make([]any, 0, len(words)*2)
	for i, w := range words {
		conds[i] = "(d.title LIKE ? OR d.content LIKE ?)"
		likeArgs = append(likeArgs, "%"+w+"%", "%"+w+"%")
	}
	where := fmt.Sprintf(`d.folder_id IN (%s) AND d.status = 'ready' AND (
		d.id IN (SELECT rowid FROM kb_fts WHERE kb_fts MATCH ?) OR %s)`, in, strings.Join(conds, " AND "))
	whereArgs := append(append([]any{}, inArgs()...), append([]any{ftsMatch}, likeArgs...)...)

	var total int64
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_documents d WHERE "+where, whereArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// FTS hits first ordered by bm25, LIKE-only hits appended (NULL score).
	// bm25() is NULL for joined FTS rows outside the MATCH result set.
	rows, err := db.Query(`SELECT d.id, d.folder_id, d.title, d.content, d.content_type, d.size, d.source, d.created_by,
			COALESCE(bm25(kb_fts), 0)
		FROM kb_documents d LEFT JOIN kb_fts f ON f.rowid = d.id
		WHERE `+where+`
		ORDER BY (d.id IN (SELECT rowid FROM kb_fts WHERE kb_fts MATCH ?)) DESC, bm25(kb_fts) ASC
		LIMIT ? OFFSET ?`,
		append(append(whereArgs, ftsMatch), pageSize, (page-1)*pageSize)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]SearchResult, 0, pageSize)
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.ID, &r.FolderID, &r.Title, &r.Content, &r.ContentType, &r.Size, &r.Source, &r.CreatedBy, &r.Score); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}
