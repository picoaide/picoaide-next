package knowledge

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxKBContent caps a single document's text content (memory/disk guard;
// real documents are far below 1MB of plain text).
const maxKBContent = 1 << 20

// IndexDocument stores a document into the knowledge base, recording the
// extracted text length as its size. txt/md text is accepted as-is; docx/pdf
// extraction happens in extract.go.
func IndexDocument(db *sql.DB, folderID int64, title, content, contentType, source, createdBy string) (int64, error) {
	if len(content) > maxKBContent {
		return 0, errors.New(fmt.Sprintf("文档内容超过上限 %d 字节", maxKBContent))
	}
	return serverstore.CreateKBDocument(db, folderID, title, content, contentType, int64(len(content)), source, createdBy)
}
