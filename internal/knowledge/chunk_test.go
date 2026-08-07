package knowledge

import (
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
	"testing"
)

// chunkText returns the joined content of chunks for assertions.
func chunkContents(chunks []serverstore.KBChunk) []string {
	out := make([]string, len(chunks))
	for i, c := range chunks {
		out[i] = c.Content
	}
	return out
}

func TestChunkTextParagraphMerging(t *testing.T) {
	// short paragraphs merge into ~800-rune chunks
	var lines []string
	for i := 0; i < 30; i++ {
		lines = append(lines, strings.Repeat("段落", 10)+"。")
	}
	content := strings.Join(lines, "\n")
	chunks := ChunkText(content)
	if len(chunks) != 1 {
		t.Fatalf("got %d chunks, want 1 (all short paragraphs merged)", len(chunks))
	}
	if c := chunks[0]; c.CharStart != 0 || c.CharEnd != int64(len([]rune(content))) {
		t.Fatalf("char range %d-%d, want 0-%d", c.CharStart, c.CharEnd, len([]rune(content)))
	}
}

func TestChunkTextMaxSize(t *testing.T) {
	// a doc of 10 x 200-rune paragraphs = 2000 runes > 800 → split
	var lines []string
	for i := 0; i < 10; i++ {
		lines = append(lines, strings.Repeat("甲", 200))
	}
	chunks := ChunkText(strings.Join(lines, "\n"))
	if len(chunks) < 2 {
		t.Fatalf("got %d chunks, want >= 2", len(chunks))
	}
	for _, c := range chunks {
		if n := len([]rune(c.Content)); n > maxChunkRunes+overlapRunes {
			t.Fatalf("chunk size %d exceeds cap", n)
		}
	}
}

func TestChunkTextOverlap(t *testing.T) {
	// consecutive same-section chunks share the tail of the previous one
	var lines []string
	for i := 0; i < 10; i++ {
		lines = append(lines, strings.Repeat("甲", 200))
	}
	chunks := ChunkText(strings.Join(lines, "\n"))
	for i := 1; i < len(chunks); i++ {
		prev := chunks[i-1].Content
		cur := chunks[i].Content
		if !strings.HasPrefix(cur, tailRunes(prev, overlapRunes)) {
			t.Fatalf("chunk %d has no overlap prefix of chunk %d", i, i-1)
		}
	}
}

func TestChunkTextNoOverlapAfterHeading(t *testing.T) {
	// first section: several 甲 paragraphs (will chunk multiple times),
	// then a heading opens the 乙 section: the first 乙 chunk must not
	// carry the tail of the last 甲 chunk as overlap, and must record the
	// heading path
	content := ""
	for i := 0; i < 6; i++ {
		content += strings.Repeat("甲", 200) + "\n"
	}
	content += "第二章 乙节\n"
	for i := 0; i < 6; i++ {
		content += strings.Repeat("乙", 200) + "\n"
	}
	chunks := ChunkText(content)
	for _, c := range chunks {
		if strings.ContainsRune(c.Content, '乙') {
			if strings.ContainsRune(c.Content, '甲') {
				t.Fatalf("chunk mixes 甲 overlap into the 乙 section: %q", c.Content[:40])
			}
			if c.TitlePath != "第二章 乙节" {
				t.Fatalf("title path = %q, want 第二章 乙节", c.TitlePath)
			}
			return
		}
	}
	t.Fatal("no chunk in the 乙 section")
}

func TestChunkTextTitlePath(t *testing.T) {
	content := "第一章 总则\n第一条 适用范围\n本规定适用于全体员工。\n本规定解释权归人事部。\n第二章 报销\n第二条 标准\n差旅费按标准报销。\n"
	chunks := ChunkText(content)
	found := false
	for _, c := range chunks {
		if strings.Contains(c.TitlePath, "总则") && strings.Contains(c.TitlePath, "适用范围") {
			if !strings.Contains(c.Content, "本规定") {
				t.Fatalf("content missing under heading path: %q", c.Content)
			}
			found = true
		}
	}
	if !found {
		paths := []string{}
		for _, c := range chunks {
			paths = append(paths, c.TitlePath)
		}
		t.Fatalf("no chunk under 总则>适用范围, paths: %v", paths)
	}
}

func TestChunkTextLongParagraphSentenceSplit(t *testing.T) {
	// a single > hardSplitRunes paragraph without newlines must still be
	// split at sentence ends instead of becoming one giant chunk
	content := strings.Repeat("句子内容甲。", 600) // 3000+ runes, no newline
	chunks := ChunkText(content)
	if len(chunks) < 2 {
		t.Fatalf("got %d chunks, want >= 2", len(chunks))
	}
	for _, c := range chunks {
		if n := len([]rune(c.Content)); n > maxChunkRunes+overlapRunes {
			t.Fatalf("hard-split chunk size %d exceeds cap", n)
		}
	}
}

func TestChunkTextCharOffsets(t *testing.T) {
	content := strings.Repeat("甲", 300) + "\n" + strings.Repeat("乙", 300) + "\n" + strings.Repeat("丙", 300)
	chunks := ChunkText(content)
	if len(chunks) < 2 {
		t.Fatal("want >= 2 chunks")
	}
	for _, c := range chunks {
		got := string([]rune(content)[c.CharStart:c.CharEnd])
		if !strings.Contains(c.Content, got) && !strings.Contains(got, c.Content) {
			t.Fatalf("offset range %d-%d does not match chunk content", c.CharStart, c.CharEnd)
		}
	}
}

func TestChunkTextNoHeadingLines(t *testing.T) {
	// numbered-looking content lines must not be treated as headings
	// (e.g. "2024年数据" or "3.5倍"), and title path stays empty
	content := "2024年销售额\n3.5倍增长\n以上数据仅供参考\n"
	chunks := ChunkText(content)
	for _, c := range chunks {
		if c.TitlePath != "" {
			t.Fatalf("title path %q set for non-heading content", c.TitlePath)
		}
	}
}
