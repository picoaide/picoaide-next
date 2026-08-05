package knowledge

import (
	"database/sql"
	"errors"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// RegisterAdminRoutes mounts /api/admin/kb/* behind AdminAuth.
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB) {
	g := r.Group("/api/admin/kb", serverauth.AdminAuth(db))
	g.POST("/upload", func(c *gin.Context) { uploadDoc(c, db) })
	g.POST("/folders", func(c *gin.Context) { createFolder(c, db) })
	g.GET("/folders", func(c *gin.Context) { listFolders(c, db) })
	g.GET("/documents", func(c *gin.Context) { listDocuments(c, db) })
	g.DELETE("/documents/:id", func(c *gin.Context) { deleteDoc(c, db) })
	g.PUT("/documents/:id", func(c *gin.Context) { updateDoc(c, db) })
	g.GET("/documents/:id", func(c *gin.Context) { getDoc(c, db) })
	g.PUT("/folders/:id/grant", func(c *gin.Context) { grantFolder(c, db) })
	g.DELETE("/folders/:id/grant", func(c *gin.Context) { revokeGrant(c, db) })
	g.GET("/folders/:id/grants", func(c *gin.Context) { listGrants(c, db) })
	g.GET("/search", func(c *gin.Context) { search(c, db) })
	g.GET("/audit", func(c *gin.Context) { listAudit(c, db) })
}

func adminUsername(c *gin.Context) string {
	u := serverauth.AdminUser(c)
	if u == nil {
		return "admin"
	}
	return u.Username
}

type kbUploadReq struct {
	Title       string `json:"title"`
	Content     string `json:"content"`
	FolderID    int64  `json:"folder_id"`
	ContentType string `json:"content_type"`
}

func uploadDoc(c *gin.Context, db *sql.DB) {
	title := ""
	folderID := int64(0)
	var content, contentType string
	var err error

	if strings.HasPrefix(c.ContentType(), "multipart/form-data") {
		// file upload: txt/md/docx/pdf, text extracted server-side
		var fh *multipart.FileHeader
		if fh, err = c.FormFile("file"); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少 file 文件字段")
			return
		}
		title = c.PostForm("title")
		if title == "" {
			title = fh.Filename
		}
		folderID, _ = strconv.ParseInt(c.PostForm("folder_id"), 10, 64)
		if content, contentType, err = extractFile(fh); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
			return
		}
	} else {
		var req kbUploadReq
		if err := c.ShouldBindJSON(&req); err != nil || req.Title == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "标题必填")
			return
		}
		title, content, contentType = req.Title, req.Content, req.ContentType
		if contentType == "" {
			contentType = "text"
		}
		folderID = req.FolderID
	}
	if folderID < 0 {
		folderID = 0
	}
	id, err := IndexDocument(db, folderID, title, content, contentType, "admin", adminUsername(c))
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "上传失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_upload", "doc#"+strconv.FormatInt(id, 10)+" "+title)
	c.JSON(http.StatusOK, gin.H{"doc": gin.H{"id": id, "title": title}})
}

func createFolder(c *gin.Context, db *sql.DB) {
	var req struct {
		Name     string `json:"name"`
		ParentID int64  `json:"parent_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称必填")
		return
	}
	id, err := serverstore.CreateKBFolder(db, req.Name, req.ParentID)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"folder": gin.H{"id": id, "name": req.Name}})
}

func listFolders(c *gin.Context, db *sql.DB) {
	folders, err := serverstore.ListKBFolders(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(folders))
	for _, f := range folders {
		out = append(out, gin.H{"id": f.ID, "name": f.Name, "parent_id": f.ParentID})
	}
	c.JSON(http.StatusOK, gin.H{"folders": out})
}

func listDocuments(c *gin.Context, db *sql.DB) {
	folderID, _ := strconv.ParseInt(c.DefaultQuery("folder_id", "0"), 10, 64)
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 20
	}
	docs, total, err := serverstore.ListKBDocumentsPaged(db, folderID, (page-1)*size, size)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(docs))
	for _, d := range docs {
		out = append(out, gin.H{"id": d.ID, "folder_id": d.FolderID, "title": d.Title,
			"content_type": d.ContentType, "size": d.Size, "created_by": d.CreatedBy})
	}
	c.JSON(http.StatusOK, gin.H{"documents": out, "total": total})
}

func listAudit(c *gin.Context, db *sql.DB) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "50"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 50
	}
	logs, total, err := serverstore.ListAuditLogsPaged(db, (page-1)*size, size)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(logs))
	for _, l := range logs {
		out = append(out, gin.H{"id": l.ID, "username": l.Username, "action": l.Action,
			"detail": l.Detail, "created_at": l.CreatedAt.Format(time.RFC3339)})
	}
	c.JSON(http.StatusOK, gin.H{"logs": out, "total": total})
}

func deleteDoc(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if err := serverstore.DeleteKBDocument(db, id); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_delete", "doc#"+strconv.FormatInt(id, 10)+" "+doc.Title)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func grantFolder(c *gin.Context, db *sql.DB) {
	folderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	var req struct {
		Username string `json:"username"`
		Group    string `json:"group"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.Username == "" && req.Group == "") {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "username 或 group 必填")
		return
	}
	if req.Username != "" {
		if err := serverstore.GrantFolderUser(db, folderID, req.Username); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
	} else {
		if err := serverstore.GrantFolderGroup(db, folderID, req.Group); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func getDoc(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"doc": gin.H{"id": doc.ID, "folder_id": doc.FolderID, "title": doc.Title,
		"content": doc.Content, "content_type": doc.ContentType}})
}

type kbUpdateReq struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

func updateDoc(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	var req kbUpdateReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Title == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "标题必填")
		return
	}
	if _, err := serverstore.GetKBDocument(db, id); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if err := UpdateDocument(db, id, req.Title, req.Content); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		} else if strings.Contains(err.Error(), "上限") {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
		} else {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		}
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_update", "doc#"+strconv.FormatInt(id, 10)+" "+req.Title)
	c.JSON(http.StatusOK, gin.H{"ok": true, "doc": gin.H{"id": id, "title": req.Title}})
}

func listGrants(c *gin.Context, db *sql.DB) {
	folderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	users, groups, err := serverstore.ListKBFolderGrants(db, folderID)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if users == nil {
		users = []string{}
	}
	if groups == nil {
		groups = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"users": users, "groups": groups})
}

func revokeGrant(c *gin.Context, db *sql.DB) {
	folderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	var req struct {
		Username string `json:"username"`
		Group    string `json:"group"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.Username == "" && req.Group == "") {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "username 或 group 必填")
		return
	}
	if req.Username != "" {
		if err := serverstore.RevokeFolderUser(db, folderID, req.Username); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "撤销失败")
			return
		}
	} else {
		if err := serverstore.RevokeFolderGroup(db, folderID, req.Group); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "撤销失败")
			return
		}
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_revoke", "folder#"+strconv.FormatInt(folderID, 10)+" "+req.Username+req.Group)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func search(c *gin.Context, db *sql.DB) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "q 必填")
		return
	}
	results, _, err := SearchAll(db, q, 1, 20)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "搜索失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"results": results})
}
