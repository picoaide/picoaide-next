package knowledge

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ChunkResult is one passage-level knowledge base hit.
type ChunkResult struct {
	ChunkID   int64   `json:"chunk_id"`
	DocID     int64   `json:"doc_id"`
	FolderID  int64   `json:"folder_id"`
	Title     string  `json:"title"`
	TitlePath string  `json:"title_path"`
	Seq       int64   `json:"seq"`
	CharStart int64   `json:"char_start"`
	Content   string  `json:"content"`
	Score     float64 `json:"score"` // lexical relevance in [0,1]
}

// ChunkDocument chunks a document's content and replaces its chunks. All
// content finalization paths (create/update/queue-complete/retry) go
// through this so chunks never drift from kb_documents.
func ChunkDocument(db *sql.DB, docID int64, content string) error {
	return serverstore.ReplaceChunks(db, docID, ChunkText(content))
}

// BackfillChunks chunks every ready document that has no chunks yet
// (pre-0014 documents). Idempotent; run once at startup.
func BackfillChunks(db *sql.DB) error {
	rows, err := db.Query(`SELECT d.id, d.content FROM kb_documents d
		WHERE d.status = 'ready' AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.doc_id = d.id)`)
	if err != nil {
		return err
	}
	var ids []int64
	var contents []string
	for rows.Next() {
		var id int64
		var content string
		if err := rows.Scan(&id, &content); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
		contents = append(contents, content)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for i, id := range ids {
		if err := serverstore.ReplaceChunks(db, id, ChunkText(contents[i])); err != nil {
			return err
		}
	}
	return nil
}

// SearchChunks queries the knowledge base at passage level and returns the
// chunks the user can access, ranked by lexical relevance.
//
// Candidate generation: query words >= 3 runes hit the chunk trigram index
// (substring, CJK-safe); 1-2 rune words hit the document unicode61 prefix
// index first (indexed narrowing) then a LIKE fallback on chunk text.
// Candidates are re-scored in Go (lexical.go) — title is the doc title plus
// the chunk's heading breadcrumb — and paginated in memory.
func SearchChunks(db *sql.DB, username string, groups []string, query string, page, pageSize int) ([]ChunkResult, int64, error) {
	folders, err := serverstore.GetAccessibleFolderIDs(db, username, groups)
	if err != nil {
		return nil, 0, err
	}
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
		return []ChunkResult{}, 0, nil
	}
	var longWords, shortWords []string
	for _, w := range words {
		if utf8.RuneCountInString(w) >= 3 {
			longWords = append(longWords, w)
		} else {
			shortWords = append(shortWords, w)
		}
	}

	in := strings.TrimSuffix(strings.Repeat("?,", len(folders)), ",")
	conds := make([]string, 0, 2)
	args := make([]any, 0, len(folders)+3)
	for _, f := range folders {
		args = append(args, f)
	}
	if len(longWords) > 0 {
		fts := make([]string, len(longWords))
		for i, w := range longWords {
			fts[i] = `"` + w + `"`
		}
		conds = append(conds, "c.id IN (SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?)")
		args = append(args, strings.Join(fts, " "))
	}
	if len(shortWords) > 0 {
		// doc-level unicode61 prefix narrows the candidate set cheaply;
		// LIKE covers mid-token short words inside a chunk
		prefix := make([]string, len(shortWords))
		for i, w := range shortWords {
			prefix[i] = `"` + w + `"*`
		}
		like := make([]string, 0, len(shortWords))
		likeArgs := make([]any, 0, len(shortWords)*2)
		for _, w := range shortWords {
			like = append(like, "(c.title_path LIKE ? OR c.content LIKE ?)")
			likeArgs = append(likeArgs, "%"+w+"%", "%"+w+"%")
		}
		conds = append(conds, `(c.doc_id IN (SELECT rowid FROM kb_fts WHERE kb_fts MATCH ?) OR `+strings.Join(like, " AND ")+`)`)
		args = append(args, strings.Join(prefix, " "))
		args = append(args, likeArgs...)
	}
	where := fmt.Sprintf(`d.folder_id IN (%s) AND d.status = 'ready' AND %s`, in, strings.Join(conds, " AND "))

	rows, err := db.Query(`SELECT c.id, c.doc_id, c.seq, c.title_path, c.content, c.char_start, d.folder_id, d.title
		FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
		WHERE `+where+` ORDER BY c.id`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	all := make([]ChunkResult, 0, 64)
	for rows.Next() {
		var r ChunkResult
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Seq, &r.TitlePath, &r.Content, &r.CharStart, &r.FolderID, &r.Title); err != nil {
			return nil, 0, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(all) == 0 {
		return []ChunkResult{}, 0, nil
	}

	qsim := newLexicalSim(strings.Join(words, " "))
	for i := range all {
		title := all[i].Title
		if all[i].TitlePath != "" {
			title += " " + all[i].TitlePath
		}
		all[i].Score = qsim.similarity(title, all[i].Content)
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Score != all[j].Score {
			return all[i].Score > all[j].Score
		}
		return all[i].ChunkID < all[j].ChunkID
	})

	total := int64(len(all))
	start := (page - 1) * pageSize
	if start >= len(all) {
		return []ChunkResult{}, total, nil
	}
	end := start + pageSize
	if end > len(all) {
		end = len(all)
	}
	return all[start:end], total, nil
}
