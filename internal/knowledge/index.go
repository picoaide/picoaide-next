package knowledge

import (
	"database/sql"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// IndexDocument stores a document into the knowledge base, recording the
// extracted text length as its size. txt/md text is accepted as-is; docx/pdf
// extraction happens in extract.go.
func IndexDocument(db *sql.DB, folderID int64, title, content, contentType, source, createdBy string) (int64, error) {
	return serverstore.CreateKBDocument(db, folderID, title, content, contentType, int64(len(content)), source, createdBy)
}
