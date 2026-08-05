package knowledge

import (
	"database/sql"
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

	byID := map[int64]SearchResult{}
	var ordered []int64

	// FTS5 hits, best relevance first.
	rows, err := db.Query(`SELECT d.id, d.folder_id, d.title, d.content, d.content_type, d.size, d.source, d.created_by, bm25(kb_fts)
		FROM kb_documents d JOIN kb_fts f ON f.rowid = d.id
		WHERE kb_fts MATCH ? AND d.folder_id IN (`+in+`) AND d.status = 'ready'
		ORDER BY bm25(kb_fts)`,
		append([]any{strings.Join(ftsQuery, " ")}, inArgs()...)...)
	if err != nil {
		return nil, 0, err
	}
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.ID, &r.FolderID, &r.Title, &r.Content, &r.ContentType, &r.Size, &r.Source, &r.CreatedBy, &r.Score); err != nil {
			rows.Close()
			return nil, 0, err
		}
		byID[r.ID] = r
		ordered = append(ordered, r.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	// LIKE fallback for recall (mid-token hanzi etc.), appended after FTS hits.
	conds := make([]string, len(words))
	likeArgs := make([]any, 0, len(words)*2)
	for i, w := range words {
		conds[i] = "(d.title LIKE ? OR d.content LIKE ?)"
		likeArgs = append(likeArgs, "%"+w+"%", "%"+w+"%")
	}
	likeArgs = append(likeArgs, inArgs()...)
	rows, err = db.Query(`SELECT id, folder_id, title, content, content_type, size, source, created_by
		FROM kb_documents d WHERE (`+strings.Join(conds, " AND ")+`) AND d.folder_id IN (`+in+`) AND d.status = 'ready'`, likeArgs...)
	if err != nil {
		return nil, 0, err
	}
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.ID, &r.FolderID, &r.Title, &r.Content, &r.ContentType, &r.Size, &r.Source, &r.CreatedBy); err != nil {
			rows.Close()
			return nil, 0, err
		}
		if _, seen := byID[r.ID]; !seen {
			byID[r.ID] = r
			ordered = append(ordered, r.ID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	total := int64(len(ordered))
	start := (page - 1) * pageSize
	if start >= len(ordered) {
		return []SearchResult{}, total, nil
	}
	end := start + pageSize
	if end > len(ordered) {
		end = len(ordered)
	}
	out := make([]SearchResult, 0, end-start)
	for _, id := range ordered[start:end] {
		out = append(out, byID[id])
	}
	return out, total, nil
}
