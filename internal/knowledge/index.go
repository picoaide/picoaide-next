package knowledge

import (
	"database/sql"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// IndexDocument stores a document into the knowledge base. txt/md text is
// accepted as-is; docx/pdf extraction is implemented in task 4.2.
func IndexDocument(db *sql.DB, folderID int64, title, content, contentType, source, createdBy string) (int64, error) {
	return serverstore.CreateKBDocument(db, folderID, title, content, contentType, 0, source, createdBy)
}
