// mock-upstream is a standalone fake OpenAI-compatible upstream server for
// environments without a real LLM key. It listens on :8081 and returns fixed
// JSON (non-stream) and SSE (stream) /chat/completions responses.
//
// Usage: go run scripts/mock-upstream.go [addr]   (default :8081)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type chatReq struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

func main() {
	addr := flag.String("addr", ":8081", "listen address")
	flag.Parse()

	http.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var req chatReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":{"message":"bad request"}}`, 400)
			return
		}
		last := ""
		lastRole := ""
		for _, m := range req.Messages {
			last = m.Content
			lastRole = m.Role
		}

		// 脚本化工具调用(E2E 用):最后一条是用户消息且含 TOOLCALL:<name> → 回工具调用;
		// 工具结果回传轮(lastRole=tool/assistant)回正常文本。支持 file_write/file_delete/command_exec。
		var scriptedTool *map[string]any
		if lastRole == "user" {
			switch {
			case strings.Contains(last, "TOOLCALL:file_write"):
				scriptedTool = &map[string]any{
					"name": "file_write",
					"arguments": `{"path":"test.txt","content":"hello e2e ` + strconv.FormatInt(time.Now().UnixMilli(), 10) + `"}`,
				}
			case strings.Contains(last, "TOOLCALL:file_delete"):
				scriptedTool = &map[string]any{
					"name": "file_delete",
					"arguments": `{"path":"delete-me.txt"}`,
				}
			case strings.Contains(last, "TOOLCALL:command_exec"):
				scriptedTool = &map[string]any{
					"name": "command_exec",
					"arguments": `{"command":"echo e2e-cmd-ok"}`,
				}
			}
		}
		content := fmt.Sprintf("mock upstream echo: %q (model=%s)", last, req.Model)

		if req.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(200)
			flusher, _ := w.(http.Flusher)
			if scriptedTool != nil {
				chunk := map[string]any{
					"id": "mock-1", "object": "chat.completion.chunk", "model": req.Model,
					"choices": []map[string]any{{
						"index": 0,
						"delta": map[string]any{
							"tool_calls": []map[string]any{{
								"index": 0,
								"id":    "call-mock-1",
								"type":  "function",
								"function": map[string]string{
									"name":      (*scriptedTool)["name"].(string),
									"arguments": (*scriptedTool)["arguments"].(string),
								},
							}},
						},
					}},
				}
				b, _ := json.Marshal(chunk)
				fmt.Fprintf(w, "data: %s\n\n", b)
				if flusher != nil {
					flusher.Flush()
				}
				fmt.Fprint(w, "data: [DONE]\n\n")
				return
			}
			for _, ch := range content {
				chunk := map[string]any{
					"id": "mock-1", "object": "chat.completion.chunk", "model": req.Model,
					"choices": []map[string]any{{"index": 0, "delta": map[string]string{"content": string(ch)}}},
				}
				b, _ := json.Marshal(chunk)
				fmt.Fprintf(w, "data: %s\n\n", b)
				if flusher != nil {
					flusher.Flush()
				}
				time.Sleep(5 * time.Millisecond)
			}
			usage := map[string]any{
				"id": "mock-1", "object": "chat.completion.chunk", "model": req.Model,
				"choices": []any{},
				"usage":   map[string]int{"prompt_tokens": 11, "completion_tokens": len(content), "total_tokens": 11 + len(content)},
			}
			b, _ := json.Marshal(usage)
			fmt.Fprintf(w, "data: %s\n\n", b)
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}

		resp := map[string]any{
			"id": "mock-1", "object": "chat.completion", "model": req.Model, "created": time.Now().Unix(),
			"choices": []map[string]any{{
				"index":         0,
				"message":       map[string]string{"role": "assistant", "content": content},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{"prompt_tokens": 11, "completion_tokens": len(content), "total_tokens": 11 + len(content)},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "mock-upstream alive")
	})
	log.Printf("mock-upstream listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
