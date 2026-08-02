package knowledge

import (
	"archive/zip"
	"errors"
	"fmt"
	"html"
	"io"
	"mime/multipart"
	"os"
	"regexp"
	"strings"

	"github.com/ledongthuc/pdf"
)

var xmlTagRE = regexp.MustCompile(`<[^>]+>`)

// extractFile saves a multipart upload to a temp file and extracts its text
// plus a content type. Supported: txt/md/docx/pdf.
func extractFile(fh *multipart.FileHeader) (content, contentType string, err error) {
	name := strings.ToLower(fh.Filename)
	switch {
	case strings.HasSuffix(name, ".txt"):
		contentType = "text"
	case strings.HasSuffix(name, ".md"):
		contentType = "markdown"
	case strings.HasSuffix(name, ".docx"):
		contentType = "docx"
	case strings.HasSuffix(name, ".pdf"):
		contentType = "pdf"
	default:
		return "", "", errors.New("仅支持 txt/md/docx/pdf 文件")
	}
	src, err := fh.Open()
	if err != nil {
		return "", "", errors.New("读取文件失败")
	}
	defer src.Close()
	tmp, err := os.CreateTemp("", "kb-upload-*")
	if err != nil {
		return "", "", errors.New("读取文件失败")
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		return "", "", errors.New("读取文件失败")
	}
	tmp.Close()

	switch contentType {
	case "text", "markdown":
		b, err := os.ReadFile(tmp.Name())
		if err != nil {
			return "", "", errors.New("读取文件失败")
		}
		content = string(b)
	case "docx":
		content, err = extractDocx(tmp.Name())
	case "pdf":
		content, err = extractPDF(tmp.Name())
	}
	if err != nil {
		return "", "", err
	}
	if strings.TrimSpace(content) == "" {
		return "", "", errors.New("无法从文件中提取文本")
	}
	return content, contentType, nil
}

// extractDocx reads word/document.xml from a docx (zip) archive, turning
// paragraphs into newlines and stripping XML markup.
func extractDocx(path string) (string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return "", fmt.Errorf("不是有效的 docx 文件: %v", err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", fmt.Errorf("docx 解析失败: %v", err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return "", fmt.Errorf("docx 解析失败: %v", err)
		}
		text := xmlTagRE.ReplaceAllString(strings.ReplaceAll(string(b), "</w:p>", "\n"), "")
		return html.UnescapeString(text), nil
	}
	return "", errors.New("不是有效的 docx 文件: 缺少 word/document.xml")
}

// extractPDF returns the plain text of a PDF.
func extractPDF(path string) (out string, err error) {
	// ponytail: ledongthuc/pdf panics on some malformed files; untrusted
	// uploads must not crash the server, so contain any panic.
	defer func() {
		if r := recover(); r != nil {
			out, err = "", fmt.Errorf("pdf 解析失败: %v", r)
		}
	}()
	f, r, err := pdf.Open(path)
	if err != nil {
		return "", fmt.Errorf("pdf 解析失败: %v", err)
	}
	defer f.Close()
	rd, err := r.GetPlainText()
	if err != nil {
		return "", fmt.Errorf("pdf 解析失败: %v", err)
	}
	b, err := io.ReadAll(rd)
	if err != nil {
		return "", fmt.Errorf("pdf 解析失败: %v", err)
	}
	return string(b), nil
}
